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
#include "Log.h"
#include "ObjectGuid.h"
#include "Opcodes.h"
#include "Player.h"
#include "SharedDefines.h"
#include "World.h"
#include "WorldPacket.h"
#include "WorldSession.h"
#include "WorldSessionMgr.h"
#include "WorldSocket.h"

#include <boost/asio/ip/tcp.hpp>
#include <algorithm>
#include <cctype>
#include <chrono>
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
        if (action != "say")
            return {400, Json::Writer().Add("ok", false).Add("error", "unsupported_action").Add("action", action).Str()};

        std::string text = req.GetString("text");
        auto ack = std::make_shared<std::promise<HttpReply>>();
        auto fut = ack->get_future();
        PushTask([this, token, text, ack]() { DoSay(token, text, ack); });

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

    void Manager::DoSay(std::string token, std::string text, std::shared_ptr<std::promise<HttpReply>> ack)
    {
        auto reply = [&](int status, std::string const& json) { ack->set_value({status, json}); };

        auto s = FindByToken(token);
        if (!s || !s->ws)
            return reply(404, Json::Writer().Add("ok", false).Add("error", "no_session").Str());
        if (s->phase.load() != BenchSession::P_INWORLD)
            return reply(409, Json::Writer().Add("ok", false).Add("error", "not_in_world").Str());
        // Confirm the core still owns this exact WorldSession before dereferencing it.
        if (sWorldSessionMgr->FindSession(s->accountId) != s->ws)
            return reply(410, Json::Writer().Add("ok", false).Add("error", "session_gone").Str());

        Player* player = s->ws->GetPlayer();
        if (!player)
            return reply(409, Json::Writer().Add("ok", false).Add("error", "no_player").Str());

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
        bool whitelisted = DecodeEvent(opcode, packet, name, dataJson);

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
         .Add("character", s.charName).Add("guid", s.targetGuidRaw).Add("inWorld", true);
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
                    w.Add("guid", (uint64_t)guid).Add("found", unknown == 0);
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
                    w.Add("type", (uint32)type).Add("language", lang).Add("senderGuid", (uint64_t)sender)
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
                        chars += Json::Writer().Add("guid", (uint64_t)guid).Add("name", cname)
                            .Add("race", (uint32)race).Add("class", (uint32)cls).Add("gender", (uint32)gender)
                            .Add("level", (uint32)level).Str();
                    }
                    chars += "]";
                    w.Add("count", (uint32)count).Raw("characters", chars);
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
