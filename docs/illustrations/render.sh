#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Generated illustrations of the widgets, in the four languages:
#   docs/assets/widgets.<lang>.png   the three widgets: now playing,
#                                    quick play and recently played
#
# They are NOT screenshots of a running Gladys: the contents come from the
# integration's own code (gen.mjs, on fictitious but realistic Spotify
# answers at a fixed date; plain gradients stand for the covers), and
# render.js draws them the way the Gladys front does (same slots, order and
# class names as front/src/components/boxs/external-widget, the official
# theme). Light theme: the dark mode of Gladys greys the badges out.
#
# Needs: Node, Chrome or Chromium (CHROME=/path/to/chrome, or the Playwright
# one), ImageMagick and Python 3 with Pillow. Run from the repository root:
#   docs/illustrations/render.sh
# -----------------------------------------------------------------------------
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
here="$repo/docs/illustrations"
out="$repo/docs/assets"
# The Gladys front the styles are taken from (master on 2026-10-13).
gladys_ref="7d3129909dde677070db5614dcf1132c9fde001d"
gladys_raw="https://raw.githubusercontent.com/GladysAssistant/Gladys/${gladys_ref}/front/src"

chrome="${CHROME:-$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | tail -n1)}"
if [ ! -x "$chrome" ]; then
  echo "Chrome not found: set CHROME=/path/to/chrome" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$here/index.html" "$here/render.js" "$work/"

# The official theme, as the Gladys front bundles it.
mkdir -p "$work/vendor/theme"
(cd "$work/vendor" && npm pack -s @gladysassistant/theme-optimized@2.1.0 >/dev/null)
tar xzf "$work"/vendor/gladysassistant-theme-optimized-*.tgz -C "$work/vendor/theme"

# The widget styles are a CSS module: its class names are used as they are,
# except `.badge`, which the theme also defines (renamed `.wbadge`).
curl -fsS "$gladys_raw/components/boxs/external-widget/style.css" |
  sed -E 's/:global\(([^)]*)\)/\1/g; s/\.badge([^A-Za-z])/.wbadge\1/g' >"$work/widget.css"
curl -fsS "$gladys_raw/style/dark-mode.css" -o "$work/dark-mode.css"

node "$here/gen.mjs" "$repo" "$work/contents.json"
{
  printf 'window.DATA='
  cat "$work/contents.json"
  printf ';\n'
} >"$work/data.js"

shot() {
  local file="$1" size="$2" query="$3"
  "$chrome" --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
    --allow-file-access-from-files --virtual-time-budget=4000 \
    --window-size="$size" --force-device-scale-factor=1.5 \
    --screenshot="$file" "file://$work/index.html?$query" >/dev/null 2>&1
  local background
  background="$(magick "$file" -format '%[pixel:p{2,2}]' info:)"
  magick "$file" -trim -bordercolor "$background" -border 30 "$file"
}

for language in en fr de es; do
  shot "$out/widgets.$language.png" 1300,1400 "lang=$language&cards=now_playing,quick_play,recently_played"
done

# 256 colors keep the small colored dots and badges exact.
python3 -I - "$out" <<'PY'
import glob
import sys
from PIL import Image

for path in glob.glob(f"{sys.argv[1]}/widgets.*.png"):
    image = Image.open(path).convert("RGB")
    image.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(
        path, optimize=True
    )
PY
ls -l "$out"/widgets.*.png
