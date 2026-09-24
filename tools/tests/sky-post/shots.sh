#!/bin/sh
# Renders a named set of harness views: sh tools/tests/sky-post/shots.sh <set> [extra query]
# Output: tools/out/sky-post-<name>.png
cd "$(dirname "$0")/../../.."
SET=${1:-sky}
EXTRA=${2:-}
shot() {
  name=$1; query=$2
  echo "== $name"
  node tools/run-page.mjs "tools/tests/sky-post/index.html?$query$EXTRA" --until window.__done --wait 180000 --size ${SIZE:-640x360} --shot tools/out/sky-post-$name.png 2>&1 | grep -v "GPU stall\|run-page\] http\|screenshot ->"
}
case $SET in
  sky)
    shot sunrise "scene=none&time=0.005&yaw=-1.5708&pitch=0.05&cov=0.3"
    shot morning "scene=none&time=0.06&yaw=-1.2&pitch=0.1"
    shot noon-up "scene=none&time=0.25&yaw=3.14159&pitch=1.2"
    shot sunset "scene=none&time=0.49&yaw=1.5708&pitch=0.06"
    shot dusk "scene=none&time=0.52&yaw=1.5708&pitch=0.15"
    shot dusk-anti "scene=none&time=0.51&yaw=-1.5708&pitch=0.15"
    shot night "scene=none&time=0.75&yaw=3.14159&pitch=0.6"
    shot night-horizon "scene=none&time=0.8&yaw=0&pitch=0.1"
    ;;
  clouds)
    shot clouds-ground "scene=none&time=0.3&yaw=2.5&pitch=0.35&cov=0.6"
    shot clouds-above "scene=none&time=0.3&yaw=2.5&pitch=-0.35&pos=0.5,300,0.5&cov=0.6"
    shot clouds-inside "scene=none&time=0.3&yaw=2.5&pitch=0.0&pos=0.5,215,0.5&cov=0.6"
    shot clouds-sunset "scene=none&time=0.47&yaw=1.3&pitch=0.2&cov=0.6"
    shot clouds-flat "scene=none&time=0.3&yaw=2.5&pitch=0.35&cov=0.6&clouds=0"
    ;;
esac
case $SET in
  world)
    W="scene=world&radius=6&rd=6&frames=3"
    shot w-noon "$W&time=0.25&pos=0.5,82,8.5&yaw=0.6&pitch=-0.3"
    shot w-afternoon "$W&time=0.41&pos=0.5,68,8.5&yaw=-1.2&pitch=-0.08"
    shot w-sunset "$W&time=0.485&pos=0.5,74,8.5&yaw=1.27&pitch=0.02"
    shot w-night "$W&time=0.78&pos=0.5,72,8.5&yaw=0.6&pitch=0.1"
    ;;
esac
case $SET in
  shafts)
    S="scene=boxes&radius=4&rd=6&frames=3"
    shot shafts-under "$S&time=0.1&pos=-38,63,-30&yaw=-1.5708&pitch=0.18"
    shot shafts-side "$S&time=0.1&pos=-10,66,5&yaw=0.35&pitch=0.05"
    shot shafts-novol "$S&time=0.1&pos=-38,63,-30&yaw=-1.5708&pitch=0.18&vol=0"
    shot boxes-water "$S&time=0.3&pos=14,62,-2&yaw=0&pitch=-0.35&sel=1&held=5"
    shot boxes-underwater "$S&time=0.3&pos=14,52,-10&yaw=0&pitch=0.25&uw=1"
    shot boxes-torch-night "$S&time=0.8&pos=-1.5,62.6,-1&yaw=0&pitch=-0.25&held=30"
    ;;
esac
