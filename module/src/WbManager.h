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

#ifndef MOD_WRATHBENCH_WBMANAGER_H
#define MOD_WRATHBENCH_WBMANAGER_H

#include "WbHttpServer.h"

#include <atomic>
#include <cstdint>
#include <functional>
#include <fstream>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

class WorldSession;
class WorldSocket;
class WorldPacket;

// The parked-socket client end is an Asio tcp socket; forward-declare the type
// so the header stays free of Asio. Defined in AzerothCore's Socket.h.
#include "Socket.h" // for IoContextTcpSocket
#include <boost/asio/io_context.hpp>

namespace WrathBench
{
    // Per-token headless session. See ADR-0009 for the parked-socket design.
    struct BenchSession
    {
        std::string token;
        std::string account;
        uint32 accountId{0};

        // The parked WorldSocket handed to the WorldSession, plus the loopback
        // client end kept open so the connection stays established.
        std::shared_ptr<WorldSocket> socket;
        std::unique_ptr<IoContextTcpSocket> clientEnd;
        WorldSession* ws{nullptr};

        // Desired character (from the /session request).
        std::string charName;
        uint8 charRace{0};
        uint8 charClass{0};
        uint8 charGender{0};

        // Login state machine, driven by the outbound packet tap.
        enum Phase { P_AUTH, P_ENUM, P_CREATE, P_ENUM2, P_LOGIN, P_INWORLD, P_DONE };
        std::atomic<int> phase{P_AUTH};
        uint64_t targetGuidRaw{0};

        // Ack for the in-flight /session request. Set exactly once, by whichever
        // of the kickoff task (sync failure) or the tap (async completion) reaches
        // the terminal state first.
        std::shared_ptr<std::promise<HttpReply>> ack;
        std::atomic<bool> ackFired{false};

        std::atomic<uint64_t> dropCount{0};
        std::atomic<uint64_t> eventSeq{0};
        std::atomic<bool> tearingDown{false};

        std::ofstream audit;
        std::mutex auditMutex;
    };

    class Manager : public IHttpSink
    {
    public:
        static Manager& Instance();

        // Lifecycle, all on the world thread.
        void Configure();
        void Start();
        void Stop();
        bool Enabled() const { return _enabled; }

        // Called from WorldScript::OnUpdate (world thread): drains queued work and
        // keeps parked sockets from being reaped as idle.
        void Update(uint32 diff);

        // Called from ServerScript::CanPacketSend. Returns true to let the packet
        // flow to the (parked) socket, false to suppress it. Bench-session packets
        // are always suppressed; whitelisted ones become JSON events first.
        bool OnPacketSend(WorldSession* ws, WorldPacket const& packet);

        // IHttpSink (io_context threads).
        HttpReply HandleHttp(std::string const& method, std::string const& target, std::string const& body) override;
        void OnWsOpen(std::string const& token, std::shared_ptr<IWsConn> conn) override;
        void OnWsClose(std::string const& token, IWsConn* conn) override;

    private:
        Manager() = default;

        // World-thread task queue.
        void PushTask(std::function<void()> fn);

        // Request handlers. The HandleHttp* run on io threads and marshal onto the
        // world thread via PushTask; the Do* run on the world thread.
        HttpReply HttpCreateSession(std::string const& body);
        HttpReply HttpAction(std::string const& body);
        HttpReply HttpDeleteSession(std::string const& body);
        HttpReply HttpHealth();

        void DoCreateSession(std::shared_ptr<BenchSession> s, std::shared_ptr<std::promise<HttpReply>> ack);
        void DoSay(std::string token, std::string text, std::shared_ptr<std::promise<HttpReply>> ack);
        void DoDeleteSession(std::string token, std::shared_ptr<std::promise<HttpReply>> ack);

        // Remove a session from the maps and close its parked socket (a client
        // disconnect at the WorldSession level). World thread only. Returns the
        // session that was removed, or nullptr if the token was unknown.
        std::shared_ptr<BenchSession> TeardownByToken(std::string const& token);

        // Tap helpers (world/map thread).
        void EmitEvent(BenchSession& s, std::string const& opcodeName, uint16_t opcodeId, std::string const& dataJson);
        void Audit(BenchSession& s, char const* kind, std::string const& json);
        void SucceedAck(BenchSession& s);
        void FailAck(BenchSession& s, std::string const& message);

        std::shared_ptr<BenchSession> FindByToken(std::string const& token);
        std::shared_ptr<BenchSession> FindByWs(WorldSession* ws);

        // config
        bool _enabled{false};
        std::string _bindAddress{"0.0.0.0"};
        uint16_t _port{8086};
        unsigned _threads{2};
        std::string _account{"RUNNER"};
        std::string _auditDir;

        std::unique_ptr<HttpServer> _http;

        // Owns the parked sockets' executor. Never run(): the sockets do no async
        // I/O (we never Start() them), so the context exists only to host them.
        boost::asio::io_context _socketIoc;

        std::mutex _taskMutex;
        std::vector<std::function<void()>> _tasks;

        // Lifetime count of dropped (non-whitelisted) outbound packets, surviving
        // session teardown so /health reflects it after a session ends.
        std::atomic<uint64_t> _totalDrops{0};

        std::mutex _sessMutex;
        std::unordered_map<std::string, std::shared_ptr<BenchSession>> _byToken;
        std::unordered_map<WorldSession*, std::shared_ptr<BenchSession>> _byWs;
        std::unordered_map<std::string, std::vector<std::shared_ptr<IWsConn>>> _wsByToken;
    };
}

#endif // MOD_WRATHBENCH_WBMANAGER_H
