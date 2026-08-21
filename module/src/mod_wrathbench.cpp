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

#include "Config.h"
#include "Log.h"
#include "ScriptMgr.h"

// Skeleton only: proves the module builds into the worldserver and its config
// file is read. The packet bridge and event tap come later; see README.md.

class WrathBenchWorldScript : public WorldScript
{
public:
    WrathBenchWorldScript() : WorldScript("WrathBenchWorldScript", {
        WORLDHOOK_ON_AFTER_CONFIG_LOAD,
        WORLDHOOK_ON_STARTUP
    }) { }

    void OnAfterConfigLoad(bool /*reload*/) override
    {
        _enabled = sConfigMgr->GetOption<bool>("WrathBench.Enable", false);
    }

    void OnStartup() override
    {
        if (!_enabled)
        {
            LOG_INFO("module", "mod-wrathbench disabled (WrathBench.Enable = 0)");
            return;
        }

        LOG_INFO("module", "mod-wrathbench loaded");
    }

private:
    bool _enabled{false};
};

// Loader entry point: name is derived from the module directory name
// (mod-wrathbench -> Addmod_wrathbenchScripts) by modules/CMakeLists.txt.
void Addmod_wrathbenchScripts()
{
    new WrathBenchWorldScript();
}
