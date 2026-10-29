#!/usr/bin/env bash
# The server log retention pass, by hand: what the chart's CronJob would prune
# now, or a run of it ahead of the schedule.
#
#   ./infra/log-retention.sh              # dry run: counts and bytes, nothing changed
#   ./infra/log-retention.sh --days 7     # the same for another window
#   ./infra/log-retention.sh --apply      # a Job from the CronJob, now; waits and prints its log
#
# The dry run is the CronJob's own script (infra/chart/wrathbench/files/
# log-retention.pl) sent over stdin into the worldserver container, where
# /proc/1 is the server: beside its counts it reports how many of the files it
# would otherwise touch that process still holds open. A past day's file a
# session idle since before midnight still holds is harmless (its next record
# rolls the file); an undated one would be the rules' proof failing, and the
# count of those should always read zero. The window defaults to the deployed
# CronJob's (`worldserver.logRetention.days`), or 3 where none is deployed yet.
# Nothing here names a file: the directory holds files named by session token
# from before stack 0.2.0.
set -Eeuo pipefail

NAMESPACE="${WRATHBENCH_K8S_NAMESPACE:-wrathbench}"
RELEASE="${WRATHBENCH_K8S_RELEASE:-wrathbench}"
DAYS=""
APPLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --days) DAYS="${2:-}"; shift 2 ;;
    --namespace|-n) NAMESPACE="${2:-}"; shift 2 ;;
    --release) RELEASE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "log-retention: unknown argument $1" >&2; exit 2 ;;
  esac
done

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/chart/wrathbench/files/log-retention.pl"
CRONJOB="cronjob/${RELEASE}-log-retention"

if [[ "${APPLY}" -eq 1 ]]; then
  if [[ -n "${DAYS}" ]]; then
    echo "log-retention: --days is for the dry run; the Job runs the CronJob's window" >&2
    exit 2
  fi
  JOB="${RELEASE}-log-retention-manual-$(date -u +%Y%m%d%H%M%S)"
  kubectl -n "${NAMESPACE}" create job --from="${CRONJOB}" "${JOB}"
  # Complete or failed, whichever comes first; the log says which.
  kubectl -n "${NAMESPACE}" wait --for=condition=complete --timeout=600s "job/${JOB}" >/dev/null 2>&1 \
    || kubectl -n "${NAMESPACE}" wait --for=condition=failed --timeout=10s "job/${JOB}" >/dev/null 2>&1 || true
  kubectl -n "${NAMESPACE}" logs "job/${JOB}"
  exit 0
fi

if [[ -z "${DAYS}" ]]; then
  DAYS="$(kubectl -n "${NAMESPACE}" get "${CRONJOB}" -o 'jsonpath={.spec.jobTemplate.spec.template.spec.containers[0].env[?(@.name=="WRATHBENCH_LOG_RETENTION_DAYS")].value}' 2>/dev/null || true)"
  if [[ -z "${DAYS}" ]]; then
    DAYS=3
    echo "log-retention: no ${CRONJOB} deployed; dry run with the chart default of ${DAYS} days" >&2
  fi
fi
# The worldserver's own env carries the port secret, which the script reads
# as AC_WRATH_BENCH_SECRET; it never leaves the container.
exec kubectl -n "${NAMESPACE}" exec -i "deployment/${RELEASE}-worldserver" -c worldserver -- \
  env DRY_RUN=1 "WRATHBENCH_LOG_RETENTION_DAYS=${DAYS}" WRATHBENCH_MODULE_HOST=127.0.0.1:8086 perl - < "${SCRIPT}"
