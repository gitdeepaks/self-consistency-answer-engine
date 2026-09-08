#!/usr/bin/env bash
set -euo pipefail
[[ "${ALLOW_LOCAL_CHAOS:-}" == yes ]] || { printf '%s\n' 'Set ALLOW_LOCAL_CHAOS=yes for the isolated sce-chaos project.' >&2; exit 2; }
# Refuse remote Docker contexts/hosts. Never operate on the development project.
[[ -z "${DOCKER_HOST:-}" ]]
endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
[[ "$endpoint" == unix://* ]]
compose=(docker compose -f infra/chaos/compose.yml -p sce-chaos)
mode="${1:-}"
case "$mode" in worker-kill|provider-stall|redis-partition) ;; *) exit 2 ;; esac
worker=$("${compose[@]}" ps -q worker)
redis=$("${compose[@]}" ps -q redis)
[[ -n "$worker" && -n "$redis" ]]
restore() {
  local result=$?
  trap - EXIT INT TERM
  case "$mode" in
    worker-kill) "${compose[@]}" start worker || result=1 ;;
    provider-stall) docker network connect sce-chaos_egress "$worker" || result=1 ;;
    redis-partition) docker network connect --alias redis sce-chaos_data "$redis" || result=1 ;;
  esac
  "${compose[@]}" exec -T redis redis-cli ping || result=1
  "${compose[@]}" ps
  exit "$result"
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
case "$mode" in
  worker-kill) "${compose[@]}" kill -s SIGKILL worker ;;
  provider-stall) docker network disconnect sce-chaos_egress "$worker" ;;
  redis-partition) docker network disconnect sce-chaos_data "$redis" ;;
esac
sleep 20
