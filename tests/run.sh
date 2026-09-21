#!/bin/sh
# Convenience wrapper. The canonical entry point is `npm test`, which is
# shell-free so it also works on the Windows CI leg.
set -e
cd "$(dirname "$0")/.."
npm test
