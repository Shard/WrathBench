# WrathBench server image: AzerothCore (pinned via the deps/azerothcore
# submodule) with modules/mod-wrathbench built in.
#
# Build context is the repository root. Adapted from the upstream
# deps/azerothcore/apps/docker/Dockerfile so stage names, paths, and the
# runtime layout match stock AzerothCore; see docs/decisions/ADR-0008.
#
# Targets:
#   worldserver -> wrathbench/worldserver
#   authserver  -> wrathbench/authserver
#   tools       -> wrathbench/tools      (map_extractor, vmap4_extractor, ...)
#   db-import   -> wrathbench/db-import  (schema import, used by bootstrap)

ARG UBUNTU_VERSION=24.04

##############################################
# Skeleton: shared directory layout          #
##############################################

FROM ubuntu:$UBUNTU_VERSION AS skeleton

ARG TZ=Etc/UTC
ARG DOCKER=1
ARG DEBIAN_FRONTEND=noninteractive

ENV AC_FORCE_CREATE_DB=1

RUN mkdir -pv \
        /azerothcore/bin                   \
        /azerothcore/data                  \
        /azerothcore/deps                  \
        /azerothcore/env/dist/bin          \
        /azerothcore/env/dist/data/Cameras \
        /azerothcore/env/dist/data/dbc     \
        /azerothcore/env/dist/data/maps    \
        /azerothcore/env/dist/data/mmaps   \
        /azerothcore/env/dist/data/vmaps   \
        /azerothcore/env/dist/logs         \
        /azerothcore/env/dist/temp         \
        /azerothcore/env/dist/etc          \
        /azerothcore/modules               \
        /azerothcore/src                   \
        /azerothcore/build

RUN apt-get update                                                       \
    && apt-get install -y --no-install-recommends tzdata ca-certificates \
    && ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime                  \
    && echo "$TZ" > /etc/timezone                                        \
    && dpkg-reconfigure --frontend noninteractive tzdata                 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /azerothcore

##############################################
# Build: compile core + tools + our module   #
##############################################

FROM skeleton AS build

ARG CTOOLS_BUILD="all"
ARG CTYPE="RelWithDebInfo"
ARG CCACHE_CPP2="true"
ARG CSCRIPTPCH="OFF"
ARG CSCRIPTS="static"
ARG CMODULES="static"
ARG CSCRIPTS_DEFAULT_LINKAGE="static"
ARG CWITH_WARNINGS="ON"
ARG CMAKE_EXTRA_OPTIONS=""

ARG CCACHE_DIR="/ccache"
ARG CCACHE_MAXSIZE="10G"
ARG CCACHE_SLOPPINESS="pch_defines,time_macros,include_file_mtime"
ARG CCACHE_COMPRESS=""
ARG CCACHE_COMPRESSLEVEL="9"
ARG CCACHE_COMPILERCHECK="content"
ARG CCACHE_LOGFILE=""

RUN apt-get update                                                        \
    && apt-get install -y --no-install-recommends                         \
        build-essential ccache libtool cmake-data ninja-build cmake clang \
        git lsb-base curl unzip default-mysql-client openssl              \
        default-libmysqlclient-dev libboost-all-dev libssl-dev libmysql++-dev \
        libreadline-dev zlib1g-dev libbz2-dev libncurses5-dev liblzma-dev \
    && rm -rf /var/lib/apt/lists/*

# AzerothCore sources come from the pinned submodule; the submodule pointer in
# our git history is the authoritative pin (see infra/PINS.md).
COPY deps/azerothcore/CMakeLists.txt /azerothcore/CMakeLists.txt
COPY deps/azerothcore/conf          /azerothcore/conf
COPY deps/azerothcore/deps          /azerothcore/deps
COPY deps/azerothcore/src           /azerothcore/src
COPY deps/azerothcore/modules       /azerothcore/modules

# Our module, dropped into modules/ where AzerothCore's CMake auto-discovers
# it. Copied last so a module edit invalidates only this layer and the build
# step (which ccache then makes fast).
COPY module /azerothcore/modules/mod-wrathbench

WORKDIR /azerothcore/build

# -DWITHOUT_GIT=1: the submodule's .git is a gitlink into the parent repo, so
# the tree carries no usable git metadata; the pin lives in our history and
# infra/PINS.md instead. The ccache cache mount is what makes module-iteration
# rebuilds fast: only changed translation units actually recompile.
RUN --mount=type=cache,target=/ccache,sharing=locked \
    cmake /azerothcore \
       -G Ninja \
       -DCMAKE_INSTALL_PREFIX="/azerothcore/env/dist"  \
       -DAPPS_BUILD="all"                              \
       -DTOOLS_BUILD="$CTOOLS_BUILD"                   \
       -DSCRIPTS="$CSCRIPTS"                           \
       -DMODULES="$CMODULES"                           \
       -DWITH_WARNINGS="$CWITH_WARNINGS"               \
       -DWITHOUT_GIT=1                                 \
       -DCMAKE_BUILD_TYPE="$CTYPE"                     \
       -DCMAKE_CXX_COMPILER="clang++"                  \
       -DCMAKE_C_COMPILER="clang"                      \
       -DCMAKE_CXX_COMPILER_LAUNCHER="ccache"          \
       -DCMAKE_C_COMPILER_LAUNCHER="ccache"            \
       -DBoost_USE_STATIC_LIBS="ON"                    \
       $CMAKE_EXTRA_OPTIONS \
    && cmake --build . --config "$CTYPE" -j $(($(nproc) + 1)) \
    && cmake --install . --config "$CTYPE"

##############################################
# Runtime base                               #
##############################################

FROM skeleton AS runtime

ARG USER_ID=1000
ARG GROUP_ID=1000
ARG DOCKER_USER=acore

ENV ACORE_COMPONENT=undefined

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      libmysqlclient21 libreadline8 libicu74 libncurses5-dev \
      gettext-base default-mysql-client \
      adduser \
    && rm -rf /var/lib/apt/lists/*

# Reference confs (worldserver.conf.dist, authserver.conf.dist, and
# modules/mod_wrathbench.conf.dist); the entrypoint copies them into
# /azerothcore/env/dist/etc at startup if absent.
COPY --from=build /azerothcore/env/dist/etc/ /azerothcore/env/ref/etc

VOLUME /azerothcore/env/dist/etc

ENV PATH="/azerothcore/env/dist/bin:$PATH"

# To use GID/UID 1000 in ubuntu > 23.04 the existing user must be deleted
# See https://bugs.launchpad.net/cloud-images/+bug/2005129
RUN userdel --remove ubuntu \
  && addgroup --gid "$GROUP_ID" "$DOCKER_USER" \
  && adduser --disabled-password --gecos '' --uid "$USER_ID" --gid "$GROUP_ID" "$DOCKER_USER" \
  && passwd -d "$DOCKER_USER" \
  && chown -R "$DOCKER_USER:$DOCKER_USER" /azerothcore

COPY --chown=$USER_ID:$GROUP_ID \
     --chmod=755 \
     deps/azerothcore/apps/docker/entrypoint.sh /azerothcore/entrypoint.sh

USER $DOCKER_USER

ENTRYPOINT ["/usr/bin/env", "bash", "/azerothcore/entrypoint.sh"]

##############################################
# Auth server                                #
##############################################

FROM runtime AS authserver
LABEL description="WrathBench AzerothCore Auth Server"

ENV ACORE_COMPONENT=authserver
ENV AC_UPDATES_ENABLE_DATABASES=0
ENV AC_DISABLE_INTERACTIVE=1
ENV AC_CLOSE_IDLE_CONNECTIONS=0

COPY --chown=$DOCKER_USER:$DOCKER_USER \
     --from=build \
     /azerothcore/env/dist/bin/authserver /azerothcore/env/dist/bin/authserver

CMD ["authserver"]

##############################################
# World server (mod-wrathbench compiled in)  #
##############################################

FROM runtime AS worldserver
LABEL description="WrathBench AzerothCore World Server + mod-wrathbench"

ENV ACORE_COMPONENT=worldserver
ENV AC_UPDATES_ENABLE_DATABASES=0
ENV AC_DISABLE_INTERACTIVE=1
ENV AC_CLOSE_IDLE_CONNECTIONS=0

COPY --chown=$DOCKER_USER:$DOCKER_USER \
     --from=build \
     /azerothcore/env/dist/bin/worldserver /azerothcore/env/dist/bin/worldserver

VOLUME /azerothcore/env/dist/etc

CMD ["worldserver"]

##############################################
# DB import (schema + module SQL migrations) #
##############################################

FROM runtime AS db-import
LABEL description="WrathBench AzerothCore Database Import tool"

USER $DOCKER_USER

ENV ACORE_COMPONENT=dbimport

COPY --chown=$DOCKER_USER:$DOCKER_USER \
    deps/azerothcore/data data

COPY --chown=$DOCKER_USER:$DOCKER_USER \
    deps/azerothcore/modules modules

COPY --chown=$DOCKER_USER:$DOCKER_USER \
    module modules/mod-wrathbench

COPY --chown=$DOCKER_USER:$DOCKER_USER \
     --from=build \
     /azerothcore/env/dist/bin/dbimport /azerothcore/env/dist/bin/dbimport

CMD [ "/azerothcore/env/dist/bin/dbimport" ]

##############################################
# Tools: client-data extractors              #
##############################################

FROM runtime AS tools
LABEL description="WrathBench AzerothCore extraction tools"

WORKDIR /azerothcore/env/dist/

RUN mkdir -pv /azerothcore/env/dist/Cameras \
              /azerothcore/env/dist/dbc     \
              /azerothcore/env/dist/maps    \
              /azerothcore/env/dist/mmaps   \
              /azerothcore/env/dist/vmaps

COPY --chown=$DOCKER_USER:$DOCKER_USER --from=build \
  /azerothcore/env/dist/bin/map_extractor /azerothcore/env/dist/bin/map_extractor

COPY --chown=$DOCKER_USER:$DOCKER_USER --from=build \
  /azerothcore/env/dist/bin/mmaps_generator /azerothcore/env/dist/bin/mmaps_generator

COPY --chown=$DOCKER_USER:$DOCKER_USER --from=build \
  /azerothcore/env/dist/bin/vmap4_assembler /azerothcore/env/dist/bin/vmap4_assembler

COPY --chown=$DOCKER_USER:$DOCKER_USER --from=build \
  /azerothcore/env/dist/bin/vmap4_extractor /azerothcore/env/dist/bin/vmap4_extractor
