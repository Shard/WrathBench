/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

#include "WbManager.h"
#include "WbJson.h"

#include "AccountMgr.h"
#include "Config.h"
#include "DatabaseEnv.h"
#include "GameTime.h"
#include "Log.h"
#include "ObjectGuid.h"
#include "Opcodes.h"
#include "PathGenerator.h"
#include "Player.h"
#include "SharedDefines.h"
#include "Timer.h"
#include "UpdateData.h"
#include "UpdateFields.h"
#include "World.h"
#include "WorldPacket.h"
#include "WorldSession.h"
#include "WorldSessionMgr.h"
#include "WorldSocket.h"

#include <boost/asio/ip/tcp.hpp>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <strings.h>

using boost::asio::ip::tcp;

namespace WrathBench
{
    static int64_t NowMs()
    {
        return std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
    }

    static std::string Sanitize(std::string const& token)
    {
        std::string out;
        for (char c : token)
            out += (std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_') ? c : '_';
        if (out.empty()) out = "session";
        return out;
    }

    Manager& Manager::Instance()
    {
        static Manager instance;
        return instance;
    }

    // -------------------------------------------------------------- config
    void Manager::Configure()
    {
        _enabled = sConfigMgr->GetOption<bool>("WrathBench.Enable", false);
        _bindAddress = sConfigMgr->GetOption<std::string>("WrathBench.BindAddress", "0.0.0.0");
        _port = static_cast<uint16_t>(sConfigMgr->GetOption<uint32>("WrathBench.Port", 8086));
        _threads = std::max<unsigned>(1, sConfigMgr->GetOption<uint32>("WrathBench.Threads", 2));
        _account = sConfigMgr->GetOption<std::string>("WrathBench.Account", "RUNNER");
        _auditDir = sConfigMgr->GetOption<std::string>("WrathBench.AuditDir", "/azerothcore/env/dist/logs/wrathbench");
    }

    void Manager::Start()
    {
        if (!_enabled)
            return;

        try
        {
            std::filesystem::create_directories(_auditDir);
        }
        catch (std::exception const& e)
        {
            LOG_WARN("module", "wrathbench: could not create audit dir '{}': {}", _auditDir, e.what());
        }

        _http = std::make_unique<HttpServer>(_bindAddress, _port, this, _threads);
        try
        {
            _http->Start();
        }
        catch (std::exception const& e)
        {
            LOG_ERROR("module", "wrathbench: HTTP server failed to start: {}", e.what());
            _http.reset();
        }
    }

    void Manager::Stop()
    {
        if (_http)
        {
            _http->Stop();
            _http.reset();
        }
        // Best-effort teardown of any live parked sockets.
        std::lock_guard<std::mutex> lock(_sessMutex);
        for (auto& [token, s] : _byToken)
            if (s->socket)
                s->socket->CloseSocket();
        _byToken.clear();
        _byWs.clear();
        _wsByToken.clear();
    }

    // --------------------------------------------------------- task queue
    void Manager::PushTask(std::function<void()> fn)
    {
        std::lock_guard<std::mutex> lock(_taskMutex);
        _tasks.push_back(std::move(fn));
    }

    void Manager::Update(uint32 /*diff*/)
    {
        std::vector<std::function<void()>> tasks;
        {
            std::lock_guard<std::mutex> lock(_taskMutex);
            tasks.swap(_tasks);
        }
        for (auto& t : tasks)
            t();

        // Drive synthesized movement (ADR-0010). World thread: maps are not
        // mid-update here, so reading player state and QueuePacket are both safe.
        TickMovers(NowMs());

        // Keep parked sockets from being reaped by the idle-connection check in
        // WorldSession::Update (it calls CloseSocket once m_timeOutTime hits 0).
        // Only deref ws when the core's own session map still points at it: the
        // core may delete a session out from under us (AddSession_ kicks a prior
        // session on the same account). A null/mismatched result is normal in the
        // tick between our AddSession and the core's AddSession_, so we skip the
        // reset but never erase the entry.
        std::lock_guard<std::mutex> lock(_sessMutex);
        for (auto& [ws, s] : _byWs)
            if (!s->tearingDown.load() && sWorldSessionMgr->FindSession(s->accountId) == ws)
                ws->ResetTimeOutTime(false);
    }

    // ----------------------------------------------------------- lookups
    std::shared_ptr<BenchSession> Manager::FindByToken(std::string const& token)
    {
        std::lock_guard<std::mutex> lock(_sessMutex);
        auto it = _byToken.find(token);
        return it == _byToken.end() ? nullptr : it->second;
    }

    std::shared_ptr<BenchSession> Manager::FindByWs(WorldSession* ws)
    {
        std::lock_guard<std::mutex> lock(_sessMutex);
        auto it = _byWs.find(ws);
        return it == _byWs.end() ? nullptr : it->second;
    }

    // ------------------------------------------------------------- HTTP
    HttpReply Manager::HandleHttp(std::string const& method, std::string const& target, std::string const& body)
    {
        try
        {
            if (method == "GET" && target == "/health")
                return HttpHealth();
            if (method == "POST" && target == "/session")
                return HttpCreateSession(body);
            if (method == "POST" && target == "/action")
                return HttpAction(body);
            if (method == "DELETE" && target == "/session")
                return HttpDeleteSession(body);

            return {404, Json::Writer().Add("ok", false).Add("error", "not_found").Str()};
        }
        catch (std::exception const& e)
        {
            return {500, Json::Writer().Add("ok", false).Add("error", "internal").Add("message", e.what()).Str()};
        }
    }

    HttpReply Manager::HttpHealth()
    {
        uint64_t sessions;
        uint64_t liveDrops = 0;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            sessions = _byToken.size();
            for (auto& [token, s] : _byToken)
                liveDrops += s->dropCount.load();
        }
        Json::Writer w;
        w.Add("ok", true);
        w.Add("module", "mod-wrathbench");
        w.Add("worldStopped", World::IsStopped());
        w.Add("sessions", sessions);
        w.Add("droppedPackets", _totalDrops.load()); // lifetime
        w.Add("droppedPacketsLive", liveDrops);      // across current sessions
        return {200, w.Str()};
    }

    HttpReply Manager::HttpCreateSession(std::string const& body)
    {
        Json::Value req = Json::Parse(body);
        std::string token = req.GetString("token");
        if (token.empty())
            return {400, Json::Writer().Add("ok", false).Add("error", "missing_token").Str()};

        if (FindByToken(token))
            return {409, Json::Writer().Add("ok", false).Add("error", "token_in_use").Str()};

        auto s = std::make_shared<BenchSession>();
        s->token = token;
        s->account = req.GetString("account", _account);
        s->charName = req.GetString("character", "");
        s->charRace = static_cast<uint8>(req.GetInt("race", 1));   // 1 = Human
        s->charClass = static_cast<uint8>(req.GetInt("class", 1));  // 1 = Warrior
        s->charGender = static_cast<uint8>(req.GetInt("gender", 0));
        if (s->charName.empty())
            return {400, Json::Writer().Add("ok", false).Add("error", "missing_character").Str()};

        auto ack = std::make_shared<std::promise<HttpReply>>();
        s->ack = ack;
        auto fut = ack->get_future();

        PushTask([this, s, ack]() { DoCreateSession(s, ack); });

        if (fut.wait_for(std::chrono::seconds(20)) != std::future_status::ready)
        {
            // Don't leave a half-built session registered with an unset promise:
            // that orphan is exactly what feeds a dangling-pointer crash on the
            // next create for this account. Tear it down on the world thread.
            PushTask([this, token]() { TeardownByToken(token); });
            return {504, Json::Writer().Add("ok", false).Add("error", "timeout").Add("token", token).Str()};
        }
        return fut.get();
    }

    HttpReply Manager::HttpAction(std::string const& body)
    {
        Json::Value req = Json::Parse(body);
        std::string token = req.GetString("token");
        std::string action = req.GetString("action");
        if (token.empty())
            return {400, Json::Writer().Add("ok", false).Add("error", "missing_token").Str()};

        auto ack = std::make_shared<std::promise<HttpReply>>();
        auto fut = ack->get_future();

        if (action == "say")
        {
            std::string text = req.GetString("text");
            PushTask([this, token, text, ack]() { DoSay(token, text, ack); });
        }
        else if (action == "move_to")
        {
            if (!req.Has("x") || !req.Has("y") || !req.Has("z"))
                return {400, Json::Writer().Add("ok", false).Add("error", "missing_position").Str()};
            float x = (float)req.GetDouble("x"), y = (float)req.GetDouble("y"), z = (float)req.GetDouble("z");
            PushTask([this, token, x, y, z, ack]() { DoMoveTo(token, x, y, z, ack); });
        }
        else if (action == "stop")
        {
            PushTask([this, token, ack]() { DoStop(token, ack); });
        }
        else if (action == "face")
        {
            bool hasO = req.Has("orientation");
            bool hasXY = req.Has("x") && req.Has("y");
            if (!hasO && !hasXY)
                return {400, Json::Writer().Add("ok", false).Add("error", "missing_face_target").Str()};
            float o = (float)req.GetDouble("orientation");
            float x = (float)req.GetDouble("x"), y = (float)req.GetDouble("y");
            PushTask([this, token, hasO, o, hasXY, x, y, ack]() { DoFace(token, hasO, o, hasXY, x, y, ack); });
        }
        else
            return {400, Json::Writer().Add("ok", false).Add("error", "unsupported_action").Add("action", action).Str()};

        if (fut.wait_for(std::chrono::seconds(10)) != std::future_status::ready)
            return {504, Json::Writer().Add("ok", false).Add("error", "timeout").Str()};
        return fut.get();
    }

    HttpReply Manager::HttpDeleteSession(std::string const& body)
    {
        Json::Value req = Json::Parse(body);
        std::string token = req.GetString("token");
        if (token.empty())
            return {400, Json::Writer().Add("ok", false).Add("error", "missing_token").Str()};

        auto ack = std::make_shared<std::promise<HttpReply>>();
        auto fut = ack->get_future();
        PushTask([this, token, ack]() { DoDeleteSession(token, ack); });

        if (fut.wait_for(std::chrono::seconds(10)) != std::future_status::ready)
            return {504, Json::Writer().Add("ok", false).Add("error", "timeout").Str()};
        return fut.get();
    }

    // ---------------------------------------------------- world-thread work
    void Manager::DoCreateSession(std::shared_ptr<BenchSession> s, std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto fail = [&](std::string const& err) {
            if (!s->ackFired.exchange(true))
                ack->set_value({400, Json::Writer().Add("ok", false).Add("error", err).Add("token", s->token).Str()});
        };

        uint32 accountId = AccountMgr::GetId(s->account);
        if (!accountId)
            return fail("unknown_account");
        s->accountId = accountId;

        // One session per account. The core's AddSession_ would otherwise kick and
        // delete the existing session, leaving us with a dangling WorldSession*.
        if (sWorldSessionMgr->FindSession(accountId))
            return fail("account_in_use");

        QueryResult info = LoginDatabase.Query(
            "SELECT expansion, flags, mutetime, locale, recruiter, totaltime FROM account WHERE id = {}", accountId);
        uint8 expansion = 2;
        uint32 flags = 0, recruiter = 0, totaltime = 0;
        uint8 locale = 0;
        int64 mutetime = 0;
        if (info)
        {
            Field* f = info->Fetch();
            expansion = f[0].Get<uint8>();
            flags = f[1].Get<uint32>();
            mutetime = f[2].Get<int64>();
            locale = f[3].Get<uint8>();
            recruiter = f[4].Get<uint32>();
            totaltime = f[5].Get<uint32>();
        }

        // Build the parked loopback socket (ADR-0009). Blocking connect then accept
        // on localhost: connect completes into the listen backlog without accept
        // running concurrently, so a single thread is fine.
        try
        {
            tcp::acceptor acc(_socketIoc, tcp::endpoint(boost::asio::ip::make_address("127.0.0.1"), 0));
            auto client = std::make_unique<IoContextTcpSocket>(_socketIoc);
            client->connect(acc.local_endpoint());
            IoContextTcpSocket server(_socketIoc);
            acc.accept(server);
            s->clientEnd = std::move(client);
            s->socket = std::make_shared<WorldSocket>(std::move(server));
        }
        catch (std::exception const& e)
        {
            return fail(std::string("socket_setup_failed"));
        }

        uint32 security = AccountMgr::GetSecurity(accountId);
        std::string name = s->account;
        WorldSession* ws = new WorldSession(accountId, std::move(name), flags, s->socket,
            static_cast<AccountTypes>(security), expansion, static_cast<time_t>(mutetime),
            static_cast<LocaleConstant>(locale), recruiter, false, security != 0, totaltime);
        ws->ValidateAccountFlags();
        s->ws = ws;

        // Open the audit log.
        {
            std::string path = _auditDir + "/" + Sanitize(s->token) + ".jsonl";
            s->audit.open(path, std::ios::out | std::ios::app);
        }

        // Register before AddSession so the tap sees the very first outbound packet.
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            _byToken[s->token] = s;
            _byWs[ws] = s;
        }

        Audit(*s, "action", Json::Writer().Add("op", "session_create").Add("account", s->account)
            .Add("character", s->charName).Add("race", (uint32)s->charRace).Add("class", (uint32)s->charClass).Str());

        s->phase.store(BenchSession::P_AUTH);
        sWorldSessionMgr->AddSession(ws);
        // Success/failure is delivered later by the tap once the login flow reaches
        // SMSG_LOGIN_VERIFY_WORLD (or an error packet). Do not set the ack here.
    }

    // Shared guard for the Do* action handlers (world thread). Validates the
    // session is in world and still owned by the core, and resolves the player.
    // On failure the error reply is set and nullptr returned.
    Player* Manager::CheckActionSession(std::shared_ptr<BenchSession> const& s,
        std::shared_ptr<std::promise<HttpReply>>& ack)
    {
        auto reply = [&](int status, char const* err) {
            ack->set_value({status, Json::Writer().Add("ok", false).Add("error", err).Str()});
            return nullptr;
        };
        if (!s || !s->ws)
            return reply(404, "no_session");
        if (s->phase.load() != BenchSession::P_INWORLD)
            return reply(409, "not_in_world");
        // Confirm the core still owns this exact WorldSession before dereferencing it.
        if (sWorldSessionMgr->FindSession(s->accountId) != s->ws)
            return reply(410, "session_gone");
        Player* player = s->ws->GetPlayer();
        if (!player)
            return reply(409, "no_player");
        return player;
    }

    void Manager::DoSay(std::string token, std::string text, std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto reply = [&](int status, std::string const& json) { ack->set_value({status, json}); };

        auto s = FindByToken(token);
        Player* player = CheckActionSession(s, ack);
        if (!player)
            return;

        // Language derived from the player's team, as a real client does. Sending
        // LANG_UNIVERSAL would be flagged as a hack by HandleMessagechatOpcode.
        uint32 lang = (player->GetTeamId() == TEAM_ALLIANCE) ? LANG_COMMON : LANG_ORCISH;

        WorldPacket* p = new WorldPacket(CMSG_MESSAGECHAT, 4 + 4 + text.size() + 1);
        *p << uint32(CHAT_MSG_SAY);
        *p << uint32(lang);
        *p << text;
        s->ws->QueuePacket(p);

        Audit(*s, "action", Json::Writer().Add("op", "say").Add("text", text).Str());
        reply(200, Json::Writer().Add("ok", true).Add("action", "say").Add("token", token).Str());
    }

    // ------------------------------------------------------------- movement
    // ADR-0010: move_to is resolved once against the server's mmaps (the single
    // sanctioned exception in docs/CONTRACTS.md), then driven as the client
    // movement packet sequence a real client would send: MSG_MOVE_START_FORWARD,
    // MSG_MOVE_HEARTBEAT at ~500ms, MSG_MOVE_STOP — all through QueuePacket into
    // the stock HandleMovementOpcodes. The agent sees progress/arrival/failure
    // events only, never the path.

    static std::string PosJson(float x, float y, float z, float o)
    {
        return Json::Writer().Add("x", (double)x).Add("y", (double)y).Add("z", (double)z).Add("o", (double)o).Str();
    }

    // Synthesize one client movement packet (MovementInfo layout mirrors
    // WorldSession::ReadMovementInfo: flags u32, flags2 u16, time u32, xyzo,
    // fallTime u32; no transport/swim/fall extras for ground movement). The
    // module's clock doubles as the "client" clock; CMSG_TIME_SYNC_RESP below
    // keeps the session's clock delta near zero so these timestamps are accepted.
    static void SendMovePacket(BenchSession& s, Player* player, uint16 opcode, uint32 moveFlags,
        float x, float y, float z, float o)
    {
        WorldPacket* p = new WorldPacket(opcode, 8 + 4 + 2 + 4 + 16 + 4);
        *p << player->GetPackGUID();
        *p << uint32(moveFlags);
        *p << uint16(0);            // flags2
        *p << uint32(getMSTime());
        *p << float(x) << float(y) << float(z) << float(o);
        *p << uint32(0);            // fallTime
        s.ws->QueuePacket(p);
    }

    void Manager::FinishMove(BenchSession& s, char const* status)
    {
        MoveState& m = s.move;
        if (!m.active)
            return;
        m.active = false;
        m.stopping = false;
        m.points.clear();

        Json::Writer w;
        w.Add("moveId", m.moveId).Add("status", status);
        // Server-confirmed position, when the session is still live: this is the
        // ground truth that the synthesized movement was actually applied.
        Player* player = (s.ws && sWorldSessionMgr->FindSession(s.accountId) == s.ws) ? s.ws->GetPlayer() : nullptr;
        if (player)
            w.Raw("pos", PosJson(player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation()));
        EmitEvent(s, "WB_MOVE_RESULT", 0xFF01, w.Str());
    }

    void Manager::DoMoveTo(std::string token, float x, float y, float z, std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto s = FindByToken(token);
        Player* player = CheckActionSession(s, ack);
        if (!player)
            return;

        Audit(*s, "action", Json::Writer().Add("op", "move_to")
            .Add("x", (double)x).Add("y", (double)y).Add("z", (double)z).Str());

        if (s->move.active)
            FinishMove(*s, "superseded");

        uint64_t moveId = ++s->moveIdGen;
        MoveState& m = s->move;
        m.moveId = moveId;

        // Ack means "queued"; the game-level outcome arrives as a WB_MOVE_RESULT
        // event, per the transport/game error split in PROTOCOL.md.
        ack->set_value({200, Json::Writer().Add("ok", true).Add("action", "move_to")
            .Add("token", token).Add("moveId", moveId).Str()});

        auto failEvent = [&](char const* status) {
            Json::Writer w;
            w.Add("moveId", moveId).Add("status", status);
            w.Raw("pos", PosJson(player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation()));
            EmitEvent(*s, "WB_MOVE_RESULT", 0xFF01, w.Str());
        };

        if (player->GetExactDist2d(x, y) > 250.0f)
            return failEvent("too_far");

        // The one sanctioned mmaps use (docs/CONTRACTS.md "Pathing"). PathGenerator
        // runs against the player's map; world thread, maps are not mid-update here.
        PathGenerator gen(player);
        bool built = gen.CalculatePath(x, y, z, false);
        PathType type = gen.GetPathType();
        Movement::PointsArray const& pts = gen.GetPath();
        bool good = built && (type & PATHFIND_NORMAL)
            && !(type & (PATHFIND_NOPATH | PATHFIND_INCOMPLETE | PATHFIND_SHORT | PATHFIND_FARFROMPOLY))
            && pts.size() >= 2;
        if (good)
        {
            G3D::Vector3 const& end = gen.GetActualEndPosition();
            float dx = end.x - x, dy = end.y - y, dz = end.z - z;
            if (dx * dx + dy * dy + dz * dz > 16.0f) // navmesh end > 4y from request
                good = false;
        }
        if (!good)
            return failEvent("no_path");

        int64_t now = NowMs();
        m.points.clear();
        m.points.reserve(pts.size());
        for (auto const& v : pts)
            m.points.push_back({v.x, v.y, v.z});
        m.seg = 0;
        m.segDone = 0.0f;
        m.lastMs = now;
        m.lastPacketMs = now;
        m.lastProgressMs = now;
        m.curX = m.points[0].x; m.curY = m.points[0].y; m.curZ = m.points[0].z;
        m.destX = m.points.back().x; m.destY = m.points.back().y; m.destZ = m.points.back().z;
        m.curO = Position::NormalizeOrientation(std::atan2(m.points[1].y - m.points[0].y, m.points[1].x - m.points[0].x));
        m.stopping = false;
        m.active = true;

        SendMovePacket(*s, player, MSG_MOVE_START_FORWARD, MOVEMENTFLAG_FORWARD, m.curX, m.curY, m.curZ, m.curO);
        Audit(*s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", "MSG_MOVE_START_FORWARD")
            .Add("moveId", moveId).Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO)).Str());
    }

    void Manager::DoStop(std::string token, std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto s = FindByToken(token);
        Player* player = CheckActionSession(s, ack);
        if (!player)
            return;

        Audit(*s, "action", Json::Writer().Add("op", "stop").Str());

        if (s->move.active)
        {
            MoveState& m = s->move;
            // Stop where the "client" is (the interpolated position); the server
            // accepts it the same way it accepts any client stop mid-run.
            SendMovePacket(*s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE, m.curX, m.curY, m.curZ, m.curO);
            FinishMove(*s, "stopped");
        }
        else
        {
            SendMovePacket(*s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE,
                player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation());
        }
        ack->set_value({200, Json::Writer().Add("ok", true).Add("action", "stop").Add("token", token).Str()});
    }

    void Manager::DoFace(std::string token, bool hasO, float o, bool hasXY, float x, float y,
        std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto s = FindByToken(token);
        Player* player = CheckActionSession(s, ack);
        if (!player)
            return;

        if (s->move.active)
            return ack->set_value({409, Json::Writer().Add("ok", false).Add("error", "moving").Str()});

        float target = hasO ? Position::NormalizeOrientation(o)
                            : (hasXY ? player->GetAngle(x, y) : player->GetOrientation());

        Audit(*s, "action", Json::Writer().Add("op", "face").Add("orientation", (double)target).Str());
        SendMovePacket(*s, player, MSG_MOVE_SET_FACING, MOVEMENTFLAG_NONE,
            player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), target);
        ack->set_value({200, Json::Writer().Add("ok", true).Add("action", "face")
            .Add("token", token).Add("orientation", (double)target).Str()});
    }

    void Manager::TickMovers(int64_t nowMs)
    {
        std::vector<std::shared_ptr<BenchSession>> sessions;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            for (auto& [token, s] : _byToken)
                if (s->move.active)
                    sessions.push_back(s);
        }
        for (auto& s : sessions)
            TickMover(*s, nowMs);
    }

    void Manager::TickMover(BenchSession& s, int64_t nowMs)
    {
        MoveState& m = s.move;
        if (!m.active || s.tearingDown.load())
        {
            m.active = false;
            return;
        }
        if (!s.ws || sWorldSessionMgr->FindSession(s.accountId) != s.ws)
        {
            m.active = false; // session died under us; nothing to report to
            return;
        }
        Player* player = s.ws->GetPlayer();
        if (!player || !player->IsInWorld())
        {
            m.active = false;
            return;
        }

        if (m.stopping)
        {
            // MSG_MOVE_STOP is queued; arrival is confirmed when the server-side
            // position reaches the destination.
            if (player->GetExactDist2d(m.destX, m.destY) < 2.5f)
                FinishMove(s, "arrived");
            else if (nowMs > m.stopDeadlineMs)
                FinishMove(s, "interrupted");
            return;
        }

        if (!player->IsAlive())
        {
            SendMovePacket(s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE,
                player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation());
            FinishMove(s, "interrupted");
            return;
        }

        int64_t dt = nowMs - m.lastMs;
        m.lastMs = nowMs;
        if (dt <= 0)
            return;

        // Advance along the polyline at the character's current run speed.
        float advance = player->GetSpeed(MOVE_RUN) * float(dt) / 1000.0f;
        while (m.seg + 1 < m.points.size())
        {
            WbVec const& a = m.points[m.seg];
            WbVec const& b = m.points[m.seg + 1];
            float sx = b.x - a.x, sy = b.y - a.y, sz = b.z - a.z;
            float segLen = std::sqrt(sx * sx + sy * sy + sz * sz);
            float remain = segLen - m.segDone;
            if (advance < remain || segLen <= 0.0001f)
            {
                m.segDone += advance;
                float t = segLen > 0.0001f ? m.segDone / segLen : 1.0f;
                m.curX = a.x + sx * t;
                m.curY = a.y + sy * t;
                m.curZ = a.z + sz * t;
                m.curO = Position::NormalizeOrientation(std::atan2(sy, sx));
                advance = 0.0f;
                break;
            }
            advance -= remain;
            ++m.seg;
            m.segDone = 0.0f;
        }

        if (m.seg + 1 >= m.points.size())
        {
            // Geometric end of path: send the stop at the exact destination and
            // wait for the server to confirm.
            m.curX = m.destX; m.curY = m.destY; m.curZ = m.destZ;
            SendMovePacket(s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE, m.destX, m.destY, m.destZ, m.curO);
            Audit(s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", "MSG_MOVE_STOP")
                .Add("moveId", m.moveId).Raw("pos", PosJson(m.destX, m.destY, m.destZ, m.curO)).Str());
            m.stopping = true;
            m.stopDeadlineMs = nowMs + 3000;
            return;
        }

        // Heartbeat cadence, as a real client: ~500ms. Before each heartbeat,
        // verify the server actually applied the previous packets; a large gap
        // means something (root, teleport, rejection) interrupted the move.
        if (nowMs - m.lastPacketMs >= 500)
        {
            if (player->GetExactDist2d(m.curX, m.curY) > 15.0f)
            {
                SendMovePacket(s, player, MSG_MOVE_STOP, MOVEMENTFLAG_NONE,
                    player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetOrientation());
                FinishMove(s, "interrupted");
                return;
            }
            SendMovePacket(s, player, MSG_MOVE_HEARTBEAT, MOVEMENTFLAG_FORWARD, m.curX, m.curY, m.curZ, m.curO);
            m.lastPacketMs = nowMs;
            Audit(s, "action", Json::Writer().Add("op", "move_pkt").Add("opcode", "MSG_MOVE_HEARTBEAT")
                .Add("moveId", m.moveId).Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO)).Str());
        }

        // Progress events: the position the module's client-side movement engine
        // is at — knowledge a real client has locally.
        if (nowMs - m.lastProgressMs >= 1000)
        {
            m.lastProgressMs = nowMs;
            Json::Writer w;
            w.Add("moveId", m.moveId);
            w.Raw("pos", PosJson(m.curX, m.curY, m.curZ, m.curO));
            EmitEvent(s, "WB_MOVE_PROGRESS", 0xFF02, w.Str());
        }
    }

    std::shared_ptr<BenchSession> Manager::TeardownByToken(std::string const& token)
    {
        std::shared_ptr<BenchSession> s;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            auto it = _byToken.find(token);
            if (it != _byToken.end())
            {
                s = it->second;
                _byToken.erase(it);
                if (s->ws)
                    _byWs.erase(s->ws);
            }
        }
        if (!s || s->tearingDown.exchange(true))
            return s;

        // Closing the parked socket is exactly a client disconnect at the WorldSession
        // level: core runs LogoutPlayer(save) on its next update and saves the char.
        if (s->socket)
            s->socket->CloseSocket();
        return s;
    }

    void Manager::DoDeleteSession(std::string token, std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto s = TeardownByToken(token);
        if (!s)
            return ack->set_value({404, Json::Writer().Add("ok", false).Add("error", "no_session").Str()});
        Audit(*s, "action", Json::Writer().Add("op", "session_delete").Str());
        ack->set_value({200, Json::Writer().Add("ok", true).Add("token", token).Str()});
    }

    // --------------------------------------------------------------- tap
    // Reads whitelisted SMSG_* into JSON. Returns true if the opcode is on the
    // whitelist (dataJson filled), false otherwise (caller counts a drop).
    static bool DecodeEvent(uint16 opcode, WorldPacket const& packet, std::string& name, std::string& dataJson);

    // Walk an SMSG_CHAR_ENUM and return the GUID of the character whose name
    // matches (case-insensitive), or 0. Selecting by name, not list position, is
    // required: the account accumulates characters across episodes, so the one we
    // just created is not necessarily first. Reading the name from the enum packet
    // (not sCharacterCache) keeps us within the observation contract.
    static uint64_t FindCharInEnum(WorldPacket const& packet, std::string const& wantName);

    bool Manager::OnPacketSend(WorldSession* ws, WorldPacket const& packet)
    {
        auto s = FindByWs(ws);
        if (!s)
            return true; // not a bench session: let the core handle it normally

        uint16 opcode = packet.GetOpcode();
        std::string name, dataJson;
        bool whitelisted;
        if (opcode == SMSG_UPDATE_OBJECT)
        {
            // The hot path (ADR-0005): decoded inline, one pass, per-session
            // object-type cache for VALUES blocks. Compression is not a concern
            // here: EncryptableAndCompressiblePacket::CompressIfNeeded runs at
            // socket-write time, below this tap, so SMSG_COMPRESSED_UPDATE_OBJECT
            // never reaches us.
            name = "SMSG_UPDATE_OBJECT";
            dataJson = DecodeUpdateObject(*s, ws, packet);
            whitelisted = true;
        }
        else
            whitelisted = DecodeEvent(opcode, packet, name, dataJson);

        // Answer time sync like a client whose clock is the server clock, so the
        // session's clock delta stays ~0 and synthesized movement timestamps are
        // accepted without the fallback-log spam in SynchronizeMovement.
        if (opcode == SMSG_TIME_SYNC_REQ)
        {
            WorldPacket copy(packet);
            uint32 counter = 0;
            if (copy.size() >= 4) copy >> counter;
            WorldPacket tmp(CMSG_TIME_SYNC_RESP, 8);
            tmp << counter << uint32(getMSTime());
            ws->QueuePacket(new WorldPacket(std::move(tmp), GameTime::Now()));
        }

        // Keep the client-side object cache in sync with destroys.
        if (opcode == SMSG_DESTROY_OBJECT && packet.size() >= 8)
        {
            WorldPacket copy(packet);
            uint64 guid = 0; copy >> guid;
            std::lock_guard<std::mutex> lock(s->objMutex);
            s->knownObjects.erase(guid);
        }

        // Drive the login state machine off the packets we observe.
        int phase = s->phase.load();
        switch (opcode)
        {
            case SMSG_AUTH_RESPONSE:
            {
                WorldPacket copy(packet);
                uint8 code = 0;
                if (copy.size() >= 1) copy >> code;
                if (phase == BenchSession::P_AUTH && code == AUTH_OK)
                {
                    WorldPacket* p = new WorldPacket(CMSG_CHAR_ENUM, 0);
                    ws->QueuePacket(p);
                    s->phase.store(BenchSession::P_ENUM);
                }
                break;
            }
            case SMSG_CHAR_ENUM:
            {
                if (phase == BenchSession::P_ENUM || phase == BenchSession::P_ENUM2)
                {
                    uint64_t matchGuid = FindCharInEnum(packet, s->charName);
                    if (matchGuid != 0)
                    {
                        s->targetGuidRaw = matchGuid;
                        WorldPacket* p = new WorldPacket(CMSG_PLAYER_LOGIN, 8);
                        *p << uint64(matchGuid);
                        ws->QueuePacket(p);
                        s->phase.store(BenchSession::P_LOGIN);
                    }
                    else if (phase == BenchSession::P_ENUM)
                    {
                        WorldPacket* p = new WorldPacket(CMSG_CHAR_CREATE, 32);
                        *p << s->charName;
                        *p << uint8(s->charRace) << uint8(s->charClass) << uint8(s->charGender);
                        *p << uint8(0) << uint8(0) << uint8(0) << uint8(0) << uint8(0) << uint8(0); // appearance + outfit
                        ws->QueuePacket(p);
                        s->phase.store(BenchSession::P_CREATE);
                    }
                    else
                    {
                        FailAck(*s, "character_missing_after_create");
                    }
                }
                break;
            }
            case SMSG_CHAR_CREATE:
            {
                WorldPacket copy(packet);
                uint8 result = 0;
                if (copy.size() >= 1) copy >> result;
                if (phase == BenchSession::P_CREATE)
                {
                    if (result == CHAR_CREATE_SUCCESS)
                    {
                        WorldPacket* p = new WorldPacket(CMSG_CHAR_ENUM, 0);
                        ws->QueuePacket(p);
                        s->phase.store(BenchSession::P_ENUM2);
                    }
                    else
                    {
                        FailAck(*s, "char_create_failed_code_" + std::to_string(result));
                    }
                }
                break;
            }
            case SMSG_LOGIN_VERIFY_WORLD:
                if (phase == BenchSession::P_LOGIN)
                {
                    s->phase.store(BenchSession::P_INWORLD);
                    SucceedAck(*s);
                }
                break;
            case SMSG_CHARACTER_LOGIN_FAILED:
                if (phase == BenchSession::P_LOGIN || phase == BenchSession::P_ENUM || phase == BenchSession::P_ENUM2)
                    FailAck(*s, "login_failed");
                break;
            default:
                break;
        }

        if (whitelisted)
            EmitEvent(*s, name, opcode, dataJson);
        else
        {
            s->dropCount.fetch_add(1);
            _totalDrops.fetch_add(1);
        }

        return false; // never write bench packets to the parked socket
    }

    // ------------------------------------------------------- ack helpers
    void Manager::SucceedAck(BenchSession& s)
    {
        if (s.ackFired.exchange(true) || !s.ack)
            return;
        Json::Writer w;
        w.Add("ok", true).Add("token", s.token).Add("account", s.account)
         .Add("character", s.charName).AddGuid("guid", s.targetGuidRaw).Add("inWorld", true);
        s.ack->set_value({200, w.Str()});
    }

    void Manager::FailAck(BenchSession& s, std::string const& message)
    {
        if (!s.ackFired.exchange(true) && s.ack)
            s.ack->set_value({502, Json::Writer().Add("ok", false).Add("error", message).Add("token", s.token).Str()});

        // A failure here means the session never reached the world; discard it so it
        // does not linger in the session maps. Called from the tap on the world
        // thread, so touching the socket is safe.
        if (s.tearingDown.exchange(true))
            return;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            _byToken.erase(s.token);
            if (s.ws)
                _byWs.erase(s.ws);
        }
        if (s.socket)
            s.socket->CloseSocket();
    }

    // --------------------------------------------------------- events/audit
    void Manager::EmitEvent(BenchSession& s, std::string const& opcodeName, uint16_t opcodeId, std::string const& dataJson)
    {
        uint64_t seq = s.eventSeq.fetch_add(1);
        Json::Writer w;
        w.Add("seq", seq).Add("opcode", opcodeName).Add("opcodeId", (uint32)opcodeId).Add("ts", (int64_t)NowMs());
        w.Raw("data", dataJson.empty() ? "{}" : dataJson);
        std::string json = w.Str();

        Audit(s, "event", json);

        std::vector<std::shared_ptr<IWsConn>> conns;
        {
            std::lock_guard<std::mutex> lock(_sessMutex);
            auto it = _wsByToken.find(s.token);
            if (it != _wsByToken.end())
                conns = it->second;
        }
        for (auto& c : conns)
            c->Send(json);
    }

    void Manager::Audit(BenchSession& s, char const* kind, std::string const& json)
    {
        std::lock_guard<std::mutex> lock(s.auditMutex);
        if (!s.audit.is_open())
            return;
        Json::Writer w;
        w.Add("ts", (int64_t)NowMs()).Add("session", s.token).Add("kind", kind);
        w.Raw("payload", json);
        s.audit << w.Str() << '\n';
        s.audit.flush();
    }

    // ------------------------------------------------------- ws attach
    void Manager::OnWsOpen(std::string const& token, std::shared_ptr<IWsConn> conn)
    {
        std::lock_guard<std::mutex> lock(_sessMutex);
        _wsByToken[token].push_back(std::move(conn));
    }

    void Manager::OnWsClose(std::string const& token, IWsConn* conn)
    {
        std::lock_guard<std::mutex> lock(_sessMutex);
        auto it = _wsByToken.find(token);
        if (it == _wsByToken.end())
            return;
        auto& vec = it->second;
        vec.erase(std::remove_if(vec.begin(), vec.end(),
            [conn](std::shared_ptr<IWsConn> const& c) { return c.get() == conn; }), vec.end());
        if (vec.empty())
            _wsByToken.erase(it);
    }

    // =================================================================
    // SMSG_UPDATE_OBJECT decoding (the observation hot path, ADR-0005/0010).
    // Layouts mirror Object::BuildCreateUpdateBlockForPlayer /
    // BuildMovementUpdate / BuildValuesUpdate and UpdateData::BuildPacket at
    // the pinned commit. Only whitelisted fields are named; everything else in
    // the mask is consumed and dropped (docs/CONTRACTS.md).
    // =================================================================

    static char const* TypeIdName(uint8 typeId)
    {
        switch (typeId)
        {
            case TYPEID_OBJECT:        return "object";
            case TYPEID_ITEM:          return "item";
            case TYPEID_CONTAINER:     return "container";
            case TYPEID_UNIT:          return "unit";
            case TYPEID_PLAYER:        return "player";
            case TYPEID_GAMEOBJECT:    return "gameObject";
            case TYPEID_DYNAMICOBJECT: return "dynamicObject";
            case TYPEID_CORPSE:        return "corpse";
            default:                   return "unknown";
        }
    }

    // Skip a Movement::PacketBuilder::WriteCreate spline blob (never served: the
    // client gets it, but serving creature spline paths would leak route data the
    // player only sees as animation; position comes from the movement block).
    static void SkipSplineCreate(WorldPacket& p)
    {
        uint32 sflags; p >> sflags;
        if (sflags & 0x00020000)      { float a; p >> a; }                    // Final_Angle
        else if (sflags & 0x00010000) { uint64 t; p >> t; }                   // Final_Target
        else if (sflags & 0x00008000) { float fx, fy, fz; p >> fx >> fy >> fz; } // Final_Point
        uint32 timePassed, duration, id; p >> timePassed >> duration >> id;
        float durMod, durModNext, vertAccel; p >> durMod >> durModNext >> vertAccel;
        uint32 effectStart; p >> effectStart;
        uint32 nodes; p >> nodes;
        p.rpos(p.rpos() + size_t(nodes) * 12);
        uint8 mode; p >> mode;
        float ex, ey, ez; p >> ex >> ey >> ez;
    }

    // Parse the movement part of a CREATE/MOVEMENT block (Object::BuildMovementUpdate)
    // and add pos / moveFlags / runSpeed / self / targetGuid to the object JSON.
    static void DecodeMovementBlockUpd(WorldPacket& p, Json::Writer& o)
    {
        uint16 flags; p >> flags;
        if (flags & UPDATEFLAG_SELF)
            o.Add("self", true);

        if (flags & UPDATEFLAG_LIVING)
        {
            uint32 mflags; uint16 mflags2; uint32 mtime;
            p >> mflags >> mflags2 >> mtime;
            float x, y, z, ori;
            p >> x >> y >> z >> ori;
            if (mflags & MOVEMENTFLAG_ONTRANSPORT)
            {
                uint64 tg; p.readPackGUID(tg);
                float tx, ty, tz, to; uint32 tt; uint8 seat;
                p >> tx >> ty >> tz >> to >> tt >> seat;
                if (mflags2 & MOVEMENTFLAG2_INTERPOLATED_MOVEMENT)
                    { uint32 t2; p >> t2; }
            }
            if ((mflags & (MOVEMENTFLAG_SWIMMING | MOVEMENTFLAG_FLYING)) || (mflags2 & MOVEMENTFLAG2_ALWAYS_ALLOW_PITCHING))
                { float pitch; p >> pitch; }
            uint32 fallTime; p >> fallTime;
            if (mflags & MOVEMENTFLAG_FALLING)
                { float a, b, c, d; p >> a >> b >> c >> d; }
            if (mflags & MOVEMENTFLAG_SPLINE_ELEVATION)
                { float se; p >> se; }
            float speeds[9];
            for (float& sp : speeds) p >> sp;
            if (mflags & MOVEMENTFLAG_SPLINE_ENABLED)
                SkipSplineCreate(p);
            o.Add("moveFlags", mflags);
            o.Raw("pos", PosJson(x, y, z, ori));
            o.Add("runSpeed", (double)speeds[1]);
        }
        else if (flags & UPDATEFLAG_POSITION)
        {
            uint64 tg; p.readPackGUID(tg);
            float x, y, z, cx, cy, cz, ori, cOri;
            p >> x >> y >> z >> cx >> cy >> cz >> ori >> cOri;
            o.Raw("pos", PosJson(x, y, z, ori));
        }
        else if (flags & UPDATEFLAG_STATIONARY_POSITION)
        {
            float x, y, z, ori;
            p >> x >> y >> z >> ori;
            o.Raw("pos", PosJson(x, y, z, ori));
        }

        if (flags & UPDATEFLAG_UNKNOWN)   { uint32 u; p >> u; }
        if (flags & UPDATEFLAG_LOWGUID)   { uint32 u; p >> u; }
        if (flags & UPDATEFLAG_HAS_TARGET)
        {
            uint64 tg = 0; p.readPackGUID(tg);
            o.AddGuid("targetGuid", (uint64_t)tg);
        }
        if (flags & UPDATEFLAG_TRANSPORT) { uint32 t; p >> t; }
        if (flags & UPDATEFLAG_VEHICLE)   { uint32 vid; float vo; p >> vid >> vo; }
        if (flags & UPDATEFLAG_ROTATION)  { int64 rot; p >> rot; }
    }

    // One whitelisted update field -> named JSON key. Returns false if the index
    // is not served (caller has already consumed the value).
    static bool AppendNamedField(Json::Writer& f, uint8 typeId, uint32 index, uint32 v,
        uint32& tLo, uint32& tHi, bool& hasLo, bool& hasHi, uint32* entryOut)
    {
        if (index == OBJECT_FIELD_ENTRY)
        {
            f.Add("entry", v);
            if (entryOut) *entryOut = v;
            return true;
        }
        if (index == OBJECT_FIELD_SCALE_X)
        {
            float fv; std::memcpy(&fv, &v, 4);
            f.Add("scale", (double)fv);
            return true;
        }

        if (typeId == TYPEID_UNIT || typeId == TYPEID_PLAYER)
        {
            if (index == UNIT_FIELD_TARGET)     { tLo = v; hasLo = true; return true; }
            if (index == UNIT_FIELD_TARGET + 1) { tHi = v; hasHi = true; return true; }
            switch (index)
            {
                case UNIT_FIELD_BYTES_0:
                    f.Add("race", v & 0xFF).Add("class", (v >> 8) & 0xFF)
                     .Add("gender", (v >> 16) & 0xFF).Add("powerType", (v >> 24) & 0xFF);
                    return true;
                case UNIT_FIELD_HEALTH:          f.Add("health", v); return true;
                case UNIT_FIELD_MAXHEALTH:       f.Add("maxHealth", v); return true;
                case UNIT_FIELD_LEVEL:           f.Add("level", v); return true;
                case UNIT_FIELD_FACTIONTEMPLATE: f.Add("faction", v); return true;
                case UNIT_FIELD_FLAGS:           f.Add("unitFlags", v); return true;
                case UNIT_FIELD_DISPLAYID:       f.Add("displayId", v); return true;
                case UNIT_DYNAMIC_FLAGS:         f.Add("dynamicFlags", v); return true;
                case UNIT_NPC_FLAGS:             f.Add("npcFlags", v); return true;
                default: break;
            }
            if (index >= UNIT_FIELD_POWER1 && index < UNIT_FIELD_POWER1 + 7)
            {
                f.Add("power" + std::to_string(index - UNIT_FIELD_POWER1 + 1), v);
                return true;
            }
            if (index >= UNIT_FIELD_MAXPOWER1 && index < UNIT_FIELD_MAXPOWER1 + 7)
            {
                f.Add("maxPower" + std::to_string(index - UNIT_FIELD_MAXPOWER1 + 1), v);
                return true;
            }
            if (typeId == TYPEID_PLAYER && index == PLAYER_FLAGS)
            {
                f.Add("playerFlags", v);
                return true;
            }
        }
        else if (typeId == TYPEID_GAMEOBJECT)
        {
            switch (index)
            {
                case GAMEOBJECT_DISPLAYID: f.Add("goDisplayId", v); return true;
                case GAMEOBJECT_FLAGS:     f.Add("goFlags", v); return true;
                case GAMEOBJECT_FACTION:   f.Add("goFaction", v); return true;
                case GAMEOBJECT_LEVEL:     f.Add("goLevel", v); return true;
                case GAMEOBJECT_BYTES_1:
                    f.Add("goState", v & 0xFF).Add("goType", (v >> 8) & 0xFF);
                    return true;
                default: break;
            }
        }
        return false;
    }

    // Parse a BuildValuesUpdate mask+values run into the whitelisted named
    // fields. All values are consumed regardless of whitelist membership.
    static std::string DecodeValuesBlock(WorldPacket& p, uint8 typeId, uint32* entryOut)
    {
        uint8 blockCount; p >> blockCount;
        uint32 mask[64]; // m_valuesCount caps far below 64*32 fields
        if (blockCount > 64)
            throw ByteBufferException();
        for (uint8 i = 0; i < blockCount; ++i)
            p >> mask[i];

        Json::Writer f;
        uint32 tLo = 0, tHi = 0;
        bool hasLo = false, hasHi = false;
        uint32 fieldCount = uint32(blockCount) * 32;
        for (uint32 i = 0; i < fieldCount; ++i)
        {
            if (!(mask[i >> 5] & (1u << (i & 31))))
                continue;
            uint32 v; p >> v;
            AppendNamedField(f, typeId, i, v, tLo, tHi, hasLo, hasHi, entryOut);
        }
        if (hasLo)
            f.AddGuid("targetGuid", uint64_t(tLo) | (uint64_t(tHi) << 32));
        return f.Str();
    }

    std::string Manager::DecodeUpdateObject(BenchSession& s, WorldSession* ws, WorldPacket const& packet)
    {
        WorldPacket p(packet);
        // Creature/name queries a real client would fire on cache miss; issued
        // after the parse so a decode error doesn't send half-baked queries.
        std::vector<std::pair<uint32, uint64_t>> creatureQueries;
        std::vector<uint64_t> nameQueries;

        Json::Writer top;
        std::string objects = "[";
        bool first = true;
        try
        {
            uint32 blockCount; p >> blockCount;
            top.Add("blocks", blockCount);
            for (uint32 b = 0; b < blockCount; ++b)
            {
                uint8 updateType; p >> updateType;
                Json::Writer o;
                switch (updateType)
                {
                    case UPDATETYPE_VALUES:
                    {
                        uint64 guid = 0; p.readPackGUID(guid);
                        uint8 typeId = 0xFF;
                        {
                            std::lock_guard<std::mutex> lock(s.objMutex);
                            auto it = s.knownObjects.find(guid);
                            if (it != s.knownObjects.end())
                                typeId = it->second;
                        }
                        o.Add("update", "values").AddGuid("guid", (uint64_t)guid);
                        std::string fields = DecodeValuesBlock(p, typeId, nullptr);
                        o.Raw("fields", fields);
                        break;
                    }
                    case UPDATETYPE_MOVEMENT:
                    {
                        uint64 guid = 0; p.readPackGUID(guid);
                        o.Add("update", "movement").AddGuid("guid", (uint64_t)guid);
                        DecodeMovementBlockUpd(p, o);
                        break;
                    }
                    case UPDATETYPE_CREATE_OBJECT:
                    case UPDATETYPE_CREATE_OBJECT2:
                    {
                        uint64 guid = 0; p.readPackGUID(guid);
                        uint8 typeId; p >> typeId;
                        o.Add("update", "create").AddGuid("guid", (uint64_t)guid)
                         .Add("objectType", TypeIdName(typeId));
                        DecodeMovementBlockUpd(p, o);
                        uint32 entry = 0;
                        std::string fields = DecodeValuesBlock(p, typeId, &entry);
                        o.Raw("fields", fields);
                        {
                            std::lock_guard<std::mutex> lock(s.objMutex);
                            s.knownObjects[guid] = typeId;
                            if (typeId == TYPEID_UNIT && entry && s.queriedCreatures.insert(entry).second)
                                creatureQueries.emplace_back(entry, guid);
                            if (typeId == TYPEID_PLAYER && s.queriedNames.insert(guid).second)
                                nameQueries.push_back(guid);
                        }
                        break;
                    }
                    case UPDATETYPE_OUT_OF_RANGE_OBJECTS:
                    case UPDATETYPE_NEAR_OBJECTS:
                    {
                        uint32 n; p >> n;
                        std::string guids = "[";
                        for (uint32 i = 0; i < n; ++i)
                        {
                            uint64 guid = 0; p.readPackGUID(guid);
                            if (i) guids += ',';
                            guids += '"' + std::to_string(guid) + '"';
                            if (updateType == UPDATETYPE_OUT_OF_RANGE_OBJECTS)
                            {
                                std::lock_guard<std::mutex> lock(s.objMutex);
                                s.knownObjects.erase(guid);
                            }
                        }
                        guids += "]";
                        o.Add("update", updateType == UPDATETYPE_OUT_OF_RANGE_OBJECTS ? "outOfRange" : "near");
                        o.Raw("guids", guids);
                        break;
                    }
                    default:
                        // Unknown block type: cannot resync the stream, bail out.
                        throw ByteBufferException();
                }
                if (!first) objects += ',';
                objects += o.Str();
                first = false;
            }
        }
        catch (std::exception const&)
        {
            return Json::Writer().Add("decodeError", true).Str();
        }
        objects += "]";
        top.Raw("objects", objects);

        for (auto const& [entry, guid] : creatureQueries)
        {
            WorldPacket* q = new WorldPacket(CMSG_CREATURE_QUERY, 12);
            *q << uint32(entry) << uint64(guid);
            ws->QueuePacket(q);
        }
        for (uint64_t guid : nameQueries)
        {
            WorldPacket* q = new WorldPacket(CMSG_NAME_QUERY, 8);
            *q << uint64(guid);
            ws->QueuePacket(q);
        }
        return top.Str();
    }

    // Opcode-name helper for the observed MSG_MOVE_* whitelist.
    static char const* MoveOpcodeName(uint16 opcode)
    {
        switch (opcode)
        {
            case MSG_MOVE_START_FORWARD:      return "MSG_MOVE_START_FORWARD";
            case MSG_MOVE_START_BACKWARD:     return "MSG_MOVE_START_BACKWARD";
            case MSG_MOVE_STOP:               return "MSG_MOVE_STOP";
            case MSG_MOVE_START_STRAFE_LEFT:  return "MSG_MOVE_START_STRAFE_LEFT";
            case MSG_MOVE_START_STRAFE_RIGHT: return "MSG_MOVE_START_STRAFE_RIGHT";
            case MSG_MOVE_STOP_STRAFE:        return "MSG_MOVE_STOP_STRAFE";
            case MSG_MOVE_JUMP:               return "MSG_MOVE_JUMP";
            case MSG_MOVE_START_TURN_LEFT:    return "MSG_MOVE_START_TURN_LEFT";
            case MSG_MOVE_START_TURN_RIGHT:   return "MSG_MOVE_START_TURN_RIGHT";
            case MSG_MOVE_STOP_TURN:          return "MSG_MOVE_STOP_TURN";
            case MSG_MOVE_SET_FACING:         return "MSG_MOVE_SET_FACING";
            case MSG_MOVE_HEARTBEAT:          return "MSG_MOVE_HEARTBEAT";
            case MSG_MOVE_FALL_LAND:          return "MSG_MOVE_FALL_LAND";
            case MSG_MOVE_START_SWIM:         return "MSG_MOVE_START_SWIM";
            case MSG_MOVE_STOP_SWIM:          return "MSG_MOVE_STOP_SWIM";
            case MSG_MOVE_SET_RUN_MODE:       return "MSG_MOVE_SET_RUN_MODE";
            case MSG_MOVE_SET_WALK_MODE:      return "MSG_MOVE_SET_WALK_MODE";
            default:                          return "MSG_MOVE";
        }
    }

    // =================================================================
    // Whitelisted SMSG decoders. Field layouts mirror the server-side
    // builders in AzerothCore at the pinned commit; see module/PROTOCOL.md.
    // =================================================================
    static bool DecodeEvent(uint16 opcode, WorldPacket const& packet, std::string& name, std::string& dataJson)
    {
        WorldPacket p(packet); // copy so reads don't disturb the live packet
        Json::Writer w;
        try
        {
            switch (opcode)
            {
                case SMSG_AUTH_RESPONSE:
                {
                    name = "SMSG_AUTH_RESPONSE";
                    uint8 code = 0; if (p.size() >= 1) p >> code;
                    w.Add("code", (uint32)code);
                    break;
                }
                case SMSG_CHAR_CREATE:
                {
                    name = "SMSG_CHAR_CREATE";
                    uint8 code = 0; if (p.size() >= 1) p >> code;
                    w.Add("result", (uint32)code);
                    break;
                }
                case SMSG_CHARACTER_LOGIN_FAILED:
                {
                    name = "SMSG_CHARACTER_LOGIN_FAILED";
                    uint8 code = 0; if (p.size() >= 1) p >> code;
                    w.Add("reason", (uint32)code);
                    break;
                }
                case SMSG_LOGIN_VERIFY_WORLD:
                {
                    name = "SMSG_LOGIN_VERIFY_WORLD";
                    uint32 map = 0; float x = 0, y = 0, z = 0, o = 0;
                    p >> map >> x >> y >> z >> o;
                    w.Add("map", map).Add("x", (double)x).Add("y", (double)y).Add("z", (double)z).Add("o", (double)o);
                    break;
                }
                case SMSG_MOTD:
                {
                    name = "SMSG_MOTD";
                    uint32 lineCount = 0; p >> lineCount;
                    std::string lines = "[";
                    for (uint32 i = 0; i < lineCount && p.rpos() < p.size(); ++i)
                    {
                        std::string line; p >> line;
                        if (i) lines += ',';
                        lines += Json::Str(line);
                    }
                    lines += "]";
                    w.Add("lineCount", lineCount).Raw("lines", lines);
                    break;
                }
                case SMSG_NOTIFICATION:
                {
                    name = "SMSG_NOTIFICATION";
                    std::string text; p >> text;
                    w.Add("text", text);
                    break;
                }
                case SMSG_NAME_QUERY_RESPONSE:
                {
                    name = "SMSG_NAME_QUERY_RESPONSE";
                    uint64 guid = 0; p.readPackGUID(guid);
                    uint8 unknown = 1; if (p.rpos() < p.size()) p >> unknown; // NameUnknown
                    w.AddGuid("guid", (uint64_t)guid).Add("found", unknown == 0);
                    if (unknown == 0 && p.rpos() < p.size())
                    {
                        std::string pname; p >> pname;
                        w.Add("name", pname);
                    }
                    break;
                }
                case SMSG_MESSAGECHAT:
                {
                    name = "SMSG_MESSAGECHAT";
                    uint8 type = 0; int32 lang = 0; uint64 sender = 0; uint32 flags = 0;
                    p >> type >> lang >> sender >> flags;
                    // For CHAT_MSG_SAY the next field is the (unused) receiver GUID.
                    uint64 receiver = 0;
                    if (p.rpos() + 8 <= p.size()) p >> receiver;
                    uint32 msgLen = 0; if (p.rpos() + 4 <= p.size()) p >> msgLen;
                    std::string msg;
                    if (msgLen > 0 && p.rpos() + msgLen <= p.size())
                    {
                        msg.assign((char const*)p.contents() + p.rpos(), msgLen);
                        if (!msg.empty() && msg.back() == '\0') msg.pop_back();
                        p.rpos(p.rpos() + msgLen);
                    }
                    uint8 chatTag = 0; if (p.rpos() < p.size()) p >> chatTag;
                    w.Add("type", (uint32)type).Add("language", lang).AddGuid("senderGuid", (uint64_t)sender)
                     .Add("message", msg).Add("chatTag", (uint32)chatTag);
                    break;
                }
                case SMSG_CHAR_ENUM:
                {
                    name = "SMSG_CHAR_ENUM";
                    uint8 count = 0; p >> count;
                    std::string chars = "[";
                    for (uint8 i = 0; i < count && p.rpos() < p.size(); ++i)
                    {
                        uint64 guid = 0; p >> guid;
                        std::string cname; p >> cname;
                        uint8 race = 0, cls = 0, gender = 0; p >> race >> cls >> gender;
                        uint8 skin, face, hair, hairColor, facial;
                        p >> skin >> face >> hair >> hairColor >> facial;
                        uint8 level = 0; p >> level;
                        uint32 zone = 0, map = 0; p >> zone >> map;
                        float x, y, z; p >> x >> y >> z;
                        uint32 guildId = 0, charFlags = 0, customize = 0; p >> guildId >> charFlags >> customize;
                        uint8 firstLogin = 0; p >> firstLogin;
                        uint32 petDisplay = 0, petLevel = 0, petFamily = 0; p >> petDisplay >> petLevel >> petFamily;
                        for (uint8 slot = 0; slot < 23; ++slot) // INVENTORY_SLOT_BAG_END
                        {
                            uint32 displayInfo = 0; uint8 invType = 0; uint32 enchant = 0;
                            p >> displayInfo >> invType >> enchant;
                        }
                        if (i) chars += ',';
                        chars += Json::Writer().AddGuid("guid", (uint64_t)guid).Add("name", cname)
                            .Add("race", (uint32)race).Add("class", (uint32)cls).Add("gender", (uint32)gender)
                            .Add("level", (uint32)level).Str();
                    }
                    chars += "]";
                    w.Add("count", (uint32)count).Raw("characters", chars);
                    break;
                }
                case SMSG_DESTROY_OBJECT:
                {
                    name = "SMSG_DESTROY_OBJECT";
                    uint64 guid = 0; p >> guid;
                    uint8 onDeath = 0; if (p.rpos() < p.size()) p >> onDeath;
                    w.AddGuid("guid", (uint64_t)guid).Add("onDeath", onDeath != 0);
                    break;
                }
                case SMSG_CREATURE_QUERY_RESPONSE:
                {
                    name = "SMSG_CREATURE_QUERY_RESPONSE";
                    uint32 entry = 0; p >> entry;
                    if (entry & 0x80000000)
                    {
                        w.Add("entry", entry & 0x7FFFFFFF).Add("found", false);
                        break;
                    }
                    std::string cname; p >> cname;
                    std::string n2, n3, n4; p >> n2 >> n3 >> n4; // always empty
                    std::string subname; p >> subname;
                    std::string iconName; p >> iconName;
                    uint32 typeFlags, ctype, family, rank;
                    p >> typeFlags >> ctype >> family >> rank;
                    w.Add("entry", entry).Add("found", true).Add("name", cname)
                     .Add("subname", subname).Add("type", ctype).Add("rank", rank);
                    break;
                }
                // Observed movement of nearby units/players, relayed by the server
                // with the same opcode the mover's client sent. Position only; the
                // extras (transport, fall, pitch) are skipped, not served.
                case MSG_MOVE_START_FORWARD: case MSG_MOVE_START_BACKWARD: case MSG_MOVE_STOP:
                case MSG_MOVE_START_STRAFE_LEFT: case MSG_MOVE_START_STRAFE_RIGHT: case MSG_MOVE_STOP_STRAFE:
                case MSG_MOVE_JUMP: case MSG_MOVE_START_TURN_LEFT: case MSG_MOVE_START_TURN_RIGHT:
                case MSG_MOVE_STOP_TURN: case MSG_MOVE_SET_FACING: case MSG_MOVE_HEARTBEAT:
                case MSG_MOVE_FALL_LAND: case MSG_MOVE_START_SWIM: case MSG_MOVE_STOP_SWIM:
                case MSG_MOVE_SET_RUN_MODE: case MSG_MOVE_SET_WALK_MODE:
                {
                    name = MoveOpcodeName(opcode);
                    uint64 guid = 0; p.readPackGUID(guid);
                    uint32 mflags = 0; uint16 mflags2 = 0; uint32 mtime = 0;
                    p >> mflags >> mflags2 >> mtime;
                    float x, y, z, o;
                    p >> x >> y >> z >> o;
                    w.AddGuid("guid", (uint64_t)guid).Add("flags", mflags).Raw("pos", PosJson(x, y, z, o));
                    break;
                }
                default:
                    return false; // not whitelisted
            }
        }
        catch (std::exception const&)
        {
            // Truncated/unexpected packet: still emit the opcode so the drop is visible.
            dataJson = Json::Writer().Add("decodeError", true).Str();
            return true;
        }
        dataJson = w.Str();
        return true;
    }

    static uint64_t FindCharInEnum(WorldPacket const& packet, std::string const& wantName)
    {
        WorldPacket p(packet);
        try
        {
            uint8 count = 0; p >> count;
            for (uint8 i = 0; i < count && p.rpos() < p.size(); ++i)
            {
                uint64 guid = 0; p >> guid;
                std::string cname; p >> cname;
                uint8 race, cls, gender; p >> race >> cls >> gender;
                uint8 skin, face, hair, hairColor, facial; p >> skin >> face >> hair >> hairColor >> facial;
                uint8 level = 0; p >> level;
                uint32 zone = 0, map = 0; p >> zone >> map;
                float x, y, z; p >> x >> y >> z;
                uint32 guildId = 0, charFlags = 0, customize = 0; p >> guildId >> charFlags >> customize;
                uint8 firstLogin = 0; p >> firstLogin;
                uint32 petDisplay = 0, petLevel = 0, petFamily = 0; p >> petDisplay >> petLevel >> petFamily;
                for (uint8 slot = 0; slot < 23; ++slot) // INVENTORY_SLOT_BAG_END
                {
                    uint32 displayInfo = 0; uint8 invType = 0; uint32 enchant = 0;
                    p >> displayInfo >> invType >> enchant;
                }
                if (strcasecmp(cname.c_str(), wantName.c_str()) == 0)
                    return guid;
            }
        }
        catch (std::exception const&)
        {
        }
        return 0;
    }
}
