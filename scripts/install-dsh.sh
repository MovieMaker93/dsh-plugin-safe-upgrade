#!/bin/sh
# Install a real dsh (dist-tag or version) into a fresh folder, the way a
# user install looks: the folder whose node_modules holds @deepseek-ai/dsh.
#   scripts/install-dsh.sh <latest|next|0.1.7-rc.2> <dir>
set -eu
spec=${1:-latest}
dir=${2:?usage: install-dsh.sh <dist-tag|version> <dir>}
mkdir -p "$dir"
printf '{"private":true}\n' > "$dir/package.json"
cd "$dir"
npm install --no-audit --no-fund --loglevel=error "@deepseek-ai/dsh@$spec"
node -p "'installed @deepseek-ai/dsh ' + require('./node_modules/@deepseek-ai/dsh/package.json').version"
