--[[
Marker Manager — RaccoonHouse Studio
=====================================
Standalone REAPER tool for the sound engineer: pick a title, pick an
episode, place markers (each optionally tagged with a character the
director already cast), then one button batch-uploads everything.

Talks DIRECTLY to the RaccoonHouse Cloudflare Worker (the cloud signaling
server) — RaccoonHouse Studio itself does NOT need to be running. This is
the key difference from a "connect to localhost" design: the Worker is
always-on regardless of any studio PC's own app being open.

Based on/extends a reference script ("Smart Marker Manager") that this
studio already used — same window-management style (gfx.* immediate-mode
canvas, ExtState persistence, generated hotkey-action for one-click marker
drop, auto-start-with-REAPER toggle). The new parts: a live cast list
fetched from the cloud instead of a manually-typed preset list, and a
batch "Відправити на сервер" upload.

--- How the character binding survives inside REAPER ---
When you pick a character from the cast list, its RaccoonHouse character
id (a UUID) gets baked into the marker's own name as a trailing
" {rh:<uuid>}" suffix — e.g. "Каеде {rh:8f0c6fdd-...}". This is REAPER's
own native marker name, visible in REAPER's own Region/Marker Manager too.
"Відправити на сервер" reads every marker currently in the project via
REAPER's own marker list, parses this suffix back out, and uploads the
whole batch. A marker created with no character selected has no suffix —
it still uploads, just with character_id = null (the director can assign
it by hand later, same as any unassigned marker made from the app itself).

--- Networking ---
ReaScript Lua has no built-in HTTP client. This shells out to curl.exe
(bundled with Windows 10+) via reaper.ExecProcess, which is SYNCHRONOUS —
REAPER's UI briefly pauses for the duration of any network call. That's
why network calls only happen on deliberate actions (opening the title
list, "Оновити список", "Відправити на сервер", and periodic reconnect
attempts while a screen is open) — never on every single UI frame.
]]--

local WORKER_BASE = "https://raccoonhouse-signaling.raccoonhause.workers.dev"
local EXT_NS = "RHMarkerManager"
local RECONNECT_INTERVAL = 5.0 -- seconds between auto-retry attempts while disconnected
local RECONNECT_MAX_ATTEMPTS = 5

-- ============================================================
-- Tiny JSON (hand-rolled — REAPER ships no JSON lib, and this keeps the
-- tool a single self-contained file like the reference script was)
-- ============================================================
local json = {}

function json.encode(v)
  local t = type(v)
  if t == "nil" then
    return "null"
  elseif t == "boolean" then
    return v and "true" or "false"
  elseif t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    return tostring(v)
  elseif t == "string" then
    local out = { '"' }
    for i = 1, #v do
      local b = v:byte(i)
      local c = v:sub(i, i)
      if c == '"' then out[#out + 1] = '\\"'
      elseif c == '\\' then out[#out + 1] = '\\\\'
      elseif b == 10 then out[#out + 1] = '\\n'
      elseif b == 13 then out[#out + 1] = '\\r'
      elseif b == 9 then out[#out + 1] = '\\t'
      elseif b < 32 then out[#out + 1] = string.format('\\u%04x', b)
      else out[#out + 1] = c end
    end
    out[#out + 1] = '"'
    return table.concat(out)
  elseif t == "table" then
    -- Only ever asked to encode flat arrays of flat objects here (the
    -- marker-upload payload) — array detection: sequential integer keys
    -- starting at 1.
    local n = 0
    for _ in pairs(v) do n = n + 1 end
    local is_array = n > 0
    for i = 1, n do
      if v[i] == nil then is_array = false break end
    end
    if n == 0 or is_array then
      local parts = {}
      for i = 1, n do parts[i] = json.encode(v[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    else
      local parts = {}
      for k, val in pairs(v) do
        parts[#parts + 1] = json.encode(tostring(k)) .. ":" .. json.encode(val)
      end
      return "{" .. table.concat(parts, ",") .. "}"
    end
  end
  return "null"
end

-- Recursive-descent JSON decoder. Returns (value, next_index) — errors
-- raise a Lua error caught by json.decode's own pcall wrapper below.
local function _skip_ws(s, i)
  while i <= #s do
    local c = s:byte(i)
    if c ~= 32 and c ~= 9 and c ~= 10 and c ~= 13 then break end
    i = i + 1
  end
  return i
end

local _parse_value -- forward decl

local function _parse_string(s, i)
  i = i + 1 -- skip opening quote
  local out = {}
  while true do
    local c = s:sub(i, i)
    if c == "" then error("unterminated string") end
    if c == '"' then
      return table.concat(out), i + 1
    elseif c == "\\" then
      local nc = s:sub(i + 1, i + 1)
      if nc == '"' then out[#out + 1] = '"'; i = i + 2
      elseif nc == "\\" then out[#out + 1] = "\\"; i = i + 2
      elseif nc == "/" then out[#out + 1] = "/"; i = i + 2
      elseif nc == "n" then out[#out + 1] = "\n"; i = i + 2
      elseif nc == "t" then out[#out + 1] = "\t"; i = i + 2
      elseif nc == "r" then out[#out + 1] = "\r"; i = i + 2
      elseif nc == "b" then out[#out + 1] = "\b"; i = i + 2
      elseif nc == "f" then out[#out + 1] = "\f"; i = i + 2
      elseif nc == "u" then
        local hex = s:sub(i + 2, i + 5)
        local cp = tonumber(hex, 16) or 0
        i = i + 6
        -- Surrogate pair (emoji etc.) — combine and encode as UTF-8.
        if cp >= 0xD800 and cp <= 0xDBFF and s:sub(i, i + 1) == "\\u" then
          local hex2 = s:sub(i + 2, i + 5)
          local cp2 = tonumber(hex2, 16) or 0
          if cp2 >= 0xDC00 and cp2 <= 0xDFFF then
            cp = 0x10000 + (cp - 0xD800) * 0x400 + (cp2 - 0xDC00)
            i = i + 6
          end
        end
        -- Encode codepoint as UTF-8 bytes.
        if cp < 0x80 then
          out[#out + 1] = string.char(cp)
        elseif cp < 0x800 then
          out[#out + 1] = string.char(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F))
        elseif cp < 0x10000 then
          out[#out + 1] = string.char(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F))
        else
          out[#out + 1] = string.char(
            0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
            0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F)
          )
        end
      else
        out[#out + 1] = nc; i = i + 2
      end
    else
      out[#out + 1] = c; i = i + 1
    end
  end
end

local function _parse_number(s, i)
  local start = i
  if s:sub(i, i) == "-" then i = i + 1 end
  while s:sub(i, i):match("%d") do i = i + 1 end
  if s:sub(i, i) == "." then
    i = i + 1
    while s:sub(i, i):match("%d") do i = i + 1 end
  end
  if s:sub(i, i) == "e" or s:sub(i, i) == "E" then
    i = i + 1
    if s:sub(i, i) == "+" or s:sub(i, i) == "-" then i = i + 1 end
    while s:sub(i, i):match("%d") do i = i + 1 end
  end
  return tonumber(s:sub(start, i - 1)), i
end

_parse_value = function(s, i)
  i = _skip_ws(s, i)
  local c = s:sub(i, i)
  if c == '"' then
    return _parse_string(s, i)
  elseif c == "{" then
    local obj = {}
    i = _skip_ws(s, i + 1)
    if s:sub(i, i) == "}" then return obj, i + 1 end
    while true do
      i = _skip_ws(s, i)
      local key
      key, i = _parse_string(s, i)
      i = _skip_ws(s, i)
      if s:sub(i, i) ~= ":" then error("expected ':'") end
      i = _skip_ws(s, i + 1)
      local val
      val, i = _parse_value(s, i)
      obj[key] = val
      i = _skip_ws(s, i)
      local sep = s:sub(i, i)
      if sep == "," then i = i + 1
      elseif sep == "}" then return obj, i + 1
      else error("expected ',' or '}'") end
    end
  elseif c == "[" then
    local arr = {}
    local n = 0
    i = _skip_ws(s, i + 1)
    if s:sub(i, i) == "]" then return arr, i + 1 end
    while true do
      i = _skip_ws(s, i)
      local val
      val, i = _parse_value(s, i)
      n = n + 1
      arr[n] = val
      i = _skip_ws(s, i)
      local sep = s:sub(i, i)
      if sep == "," then i = i + 1
      elseif sep == "]" then return arr, i + 1
      else error("expected ',' or ']'") end
    end
  elseif s:sub(i, i + 3) == "true" then
    return true, i + 4
  elseif s:sub(i, i + 4) == "false" then
    return false, i + 5
  elseif s:sub(i, i + 3) == "null" then
    return nil, i + 4
  else
    return _parse_number(s, i)
  end
end

function json.decode(s)
  if not s or s == "" then return nil, "empty" end
  local ok, value_or_err = pcall(function()
    local v = _parse_value(s, 1)
    return v
  end)
  if ok then return value_or_err, nil end
  return nil, value_or_err
end

-- ============================================================
-- Networking — curl launched via reaper.ExecProcess in TRUE background
-- mode. Confirmed live 2026-09-10: the earlier synchronous version (a
-- plain blocking ExecProcess call) froze the ENTIRE REAPER application —
-- not just this script's window — for the duration of every request, which
-- felt like REAPER itself hanging. reaper.ExecProcess(cmd, -1) launches
-- without waiting and returns immediately; completion is detected by
-- polling (every UI frame, essentially free) for an output file that only
-- ever appears once curl has fully finished — the whole curl+rename chain
-- is joined with `&&`, so a failed/interrupted/offline curl run leaves no
-- final file at all, and a poll-side timeout is what surfaces "no
-- connection" instead of REAPER blocking on it.
-- ============================================================
-- CMD's own built-in `move` (unlike modern Win32 file APIs) is picky about
-- forward slashes — confirmed live 2026-09-10 the whole curl+move chain
-- silently failed ("system cannot find the path specified") whenever the
-- path mixed TEMP's own backslashes with an appended "/". Always build
-- paths with the native separator.
local SEP = package.config:sub(1, 1)
local function tmp_dir()
  return os.getenv("TEMP") or os.getenv("TMP") or (reaper.GetResourcePath() .. SEP .. "Data")
end

local _req_seq = 0
local function _next_tmp(tag)
  _req_seq = _req_seq + 1
  return tmp_dir() .. SEP .. "rh_mm_" .. tag .. "_" .. tostring(_req_seq)
end

-- Launches a request without blocking. method: "GET"/"POST". body_json:
-- nil, or a Lua value to json.encode as the request body. Returns a
-- handle table to pass to http_poll().
local function http_start(method, url, body_json, timeout_sec)
  local body_final = _next_tmp("body") .. ".txt"
  local body_partial = body_final .. ".part"
  local status_final = _next_tmp("status") .. ".txt"
  local status_partial = status_final .. ".part"
  os.remove(body_final); os.remove(status_final)
  os.remove(body_partial); os.remove(status_partial)

  local data_arg = ""
  if body_json ~= nil then
    local req_path = _next_tmp("req") .. ".json"
    local f = io.open(req_path, "wb")
    if f then
      f:write(json.encode(body_json))
      f:close()
      data_arg = string.format(' -X %s -H "Content-Type: application/json; charset=utf-8" --data-binary @"%s"', method, req_path)
    end
  end

  -- Order matters: body is renamed into place BEFORE status — http_poll
  -- only ever checks for status_final, so its mere existence guarantees
  -- body_final is already fully written too. NO leading "cmd.exe /c" —
  -- confirmed live 2026-09-10 that ExecProcess already runs the command
  -- through its own shell layer (matches how curl examples elsewhere in
  -- the ReaScript community run directly, no cmd.exe prefix); adding one
  -- here double-wraps it and the whole chain silently fails ("system
  -- cannot find the path specified").
  local cmd = string.format(
    'curl -s -o "%s" -w "%%{http_code}" %s "%s" > "%s" && move /y "%s" "%s" >nul && move /y "%s" "%s" >nul',
    body_partial, data_arg, url, status_partial,
    body_partial, body_final,
    status_partial, status_final
  )
  reaper.ExecProcess(cmd, -1) -- fire-and-forget — does NOT block REAPER

  return {
    body_final = body_final, status_final = status_final,
    body_partial = body_partial, status_partial = status_partial,
    started_at = reaper.time_precise(), timeout_sec = timeout_sec or 12,
  }
end

-- Call every frame while a handle is outstanding. Returns "pending",
-- "timeout", or "done" (+ ok, http_status, body).
local function http_poll(handle)
  local sf = io.open(handle.status_final, "r")
  if sf then
    local status_str = sf:read("*a")
    sf:close()
    local bf = io.open(handle.body_final, "rb")
    local body = bf and bf:read("*a") or ""
    if bf then bf:close() end
    os.remove(handle.status_final)
    os.remove(handle.body_final)
    local code = tonumber((status_str or ""):match("%d+")) or 0
    return "done", (code >= 200 and code < 300), code, body
  end
  if reaper.time_precise() - handle.started_at > handle.timeout_sec then
    os.remove(handle.body_partial); os.remove(handle.status_partial)
    return "timeout"
  end
  return "pending"
end

-- ============================================================
-- ExtState persistence
-- ============================================================
local function get_ext(key, default)
  local v = reaper.GetExtState(EXT_NS, key)
  if v == "" then return default end
  return v
end
local function set_ext(key, value)
  reaper.SetExtState(EXT_NS, key, tostring(value), true)
end

-- ============================================================
-- Deterministic per-character color — Character/shared_characters carry
-- no color of their own in RaccoonHouse's data model today (confirmed
-- live 2026-09-10: marker color is a free per-session choice, only ever
-- bulk-assigned to a character afterward, never the other way around).
-- Rather than inventing new schema + a director-facing "set character
-- color" UI just for this script, the cast list colors itself: same
-- character id always hashes to the same color, here and every other
-- time this script runs, with no server round-trip needed for it.
-- ============================================================
local function _hash_string(s)
  local h = 5381
  for i = 1, #s do
    h = ((h * 33) + s:byte(i)) & 0xFFFFFFFF
  end
  return h
end

local function hsl_to_rgb(h, s, l)
  local function hue2rgb(p, q, t)
    if t < 0 then t = t + 1 end
    if t > 1 then t = t - 1 end
    if t < 1 / 6 then return p + (q - p) * 6 * t end
    if t < 1 / 2 then return q end
    if t < 2 / 3 then return p + (q - p) * (2 / 3 - t) * 6 end
    return p
  end
  if s == 0 then
    local v = math.floor(l * 255 + 0.5)
    return v, v, v
  end
  local q = l < 0.5 and (l * (1 + s)) or (l + s - l * s)
  local p = 2 * l - q
  local r = hue2rgb(p, q, h + 1 / 3)
  local g = hue2rgb(p, q, h)
  local b = hue2rgb(p, q, h - 1 / 3)
  return math.floor(r * 255 + 0.5), math.floor(g * 255 + 0.5), math.floor(b * 255 + 0.5)
end

-- Stable, reasonably distinct, medium-bright color from any id string.
local function color_for_id(id_str)
  local h = _hash_string(id_str or "")
  local hue = (h % 360) / 360
  return hsl_to_rgb(hue, 0.55, 0.55)
end

-- ============================================================
-- State
-- ============================================================
local team_id = get_ext("TeamId", "")
local screen = team_id == "" and "setup" or "titles" -- "setup" | "titles" | "episodes" | "manager"
local snapshot = nil -- decoded array of titles (from GET /shared-titles/summary)
local snapshot_is_cached = false
local selected_title = nil -- table from snapshot
local selected_episode = nil -- table from selected_title.episodes

local conn_state = "idle" -- "idle" | "connecting" | "connected" | "reconnecting" | "cached" | "error"
local conn_error_detail = nil
local reconnect_attempt = 0
local next_retry_at = 0

-- At most one network request in flight at a time — { kind = "snapshot" |
-- "send", handle = <http_start() handle>, count = <marker count, "send" only> }.
-- Polled every frame in main(); nil when idle.
local pending = nil

local current_marker = { name = "", character_id = nil, character_name = nil, color = nil, overridden = false }
local action_created = false
local scroll_y = 0
local last_mouse_state = 0
local narrow_tab = "marker" -- "marker" | "cast" — used only when window is narrow

local send_status = nil -- nil | "sending" | "ok" | "error"
local send_status_detail = nil
local send_status_until = 0

local saved_w = tonumber(get_ext("WinW", "640")) or 640
local saved_h = tonumber(get_ext("WinH", "342")) or 342
local saved_dock = tonumber(get_ext("Dock", "0")) or 0
local auto_start = get_ext("AutoStart", "0") == "1"

-- ============================================================
-- Cloud fetch
-- ============================================================
local function apply_snapshot(body)
  local decoded, err = json.decode(body)
  if not decoded then return false end
  snapshot = decoded
  set_ext("SnapshotCache", body)
  set_ext("SnapshotCacheAt", os.date("%d.%m, %H:%M"))
  return true
end

-- Called after a "snapshot" pending request resolves (see poll_pending in
-- the main loop) — never blocks itself, just interprets an already-
-- finished result.
local function finish_snapshot(ok, status, body)
  if ok and body then
    if apply_snapshot(body) then
      conn_state = "connected"
      conn_error_detail = nil
      reconnect_attempt = 0
      snapshot_is_cached = false
      return
    end
  end
  -- Failed — fall back to cache if we have one.
  local cached = get_ext("SnapshotCache", "")
  if cached ~= "" and apply_snapshot(cached) then
    conn_state = "cached"
    snapshot_is_cached = true
  else
    conn_state = "error"
    conn_error_detail = "Немає з'єднання з сервером RaccoonHouse (код: " .. tostring(status) .. ")"
  end
  reconnect_attempt = reconnect_attempt + 1
  next_retry_at = reaper.time_precise() + RECONNECT_INTERVAL
end

-- Launches the fetch WITHOUT blocking — result arrives later via
-- poll_pending(). /summary, NOT the plain /shared-titles route — that one
-- nests every episode's full subtitle_lines/markers/audio_submissions
-- (confirmed live 2026-09-10: 336KB for one real team vs 1.2KB here).
local function fetch_snapshot()
  if pending then return end
  conn_state = "connecting"
  local handle = http_start("GET", WORKER_BASE .. "/shared-titles/summary?team_id=" .. team_id, nil, 10)
  pending = { kind = "snapshot", handle = handle }
end

-- Called from the main loop, at most once every RECONNECT_INTERVAL, and
-- only while not already connected/connecting/mid-request — keeps the
-- "reconnecting…" status strip honest without hammering the network
-- every frame.
local function maybe_retry()
  if pending then return end
  if conn_state == "connected" or conn_state == "connecting" then return end
  if reconnect_attempt >= RECONNECT_MAX_ATTEMPTS then return end
  if reaper.time_precise() < next_retry_at then return end
  conn_state = "reconnecting"
  fetch_snapshot()
end

-- ============================================================
-- Reaper-native marker helpers
-- ============================================================
local RH_SUFFIX_PATTERN = "%s*{rh:([%w%-]+)}%s*$"

local function compose_marker_name(name, character_id)
  if character_id and character_id ~= "" then
    return name .. " {rh:" .. character_id .. "}"
  end
  return name
end

local function strip_rh_suffix(name)
  local char_id = name:match(RH_SUFFIX_PATTERN)
  if char_id then
    return name:gsub(RH_SUFFIX_PATTERN, ""), char_id
  end
  return name, nil
end

local function reaper_native_color(r, g, b)
  return reaper.ColorToNative(r, g, b) | 0x1000000
end

-- Mirrors the reference script's own create_action_script — writes a tiny
-- companion .lua bound to an action, so a hotkey drops a marker with
-- whatever preset (name/color/character) is CURRENTLY saved in ExtState
-- at the moment the hotkey fires, without this whole UI needing to be
-- focused.
local function create_action_script()
  local sep = package.config:sub(1, 1)
  local scripts_dir = reaper.GetResourcePath() .. sep .. "Scripts" .. sep
  local path = scripts_dir .. "RH_Drop_Marker_Action.lua"
  local f = io.open(path, "w")
  if not f then return false end
  f:write([[
local EXT_NS = "RHMarkerManager"
local name = reaper.GetExtState(EXT_NS, "CurrentName")
if name == "" then name = "Маркер" end
local char_id = reaper.GetExtState(EXT_NS, "CurrentCharacterId")
local color_str = reaper.GetExtState(EXT_NS, "CurrentColorNative")
local color = tonumber(color_str) or 0
local full_name = name
if char_id ~= "" then full_name = name .. " {rh:" .. char_id .. "}" end
local pos = reaper.GetCursorPosition()
reaper.AddProjectMarker2(0, false, pos, 0, full_name, -1, color)
reaper.UpdateTimeline()
reaper.Undo_OnStateChange("Додано маркер: " .. full_name)
]])
  f:close()
  reaper.AddRemoveReaScript(true, 0, path, true)
  return true
end

local function update_startup_script(enable)
  local is_new, script_file = reaper.get_action_context()
  if not script_file or script_file == "" then return end
  local sep = package.config:sub(1, 1)
  local startup_path = reaper.GetResourcePath() .. sep .. "Scripts" .. sep .. "__startup.lua"
  local escaped_path = script_file:gsub("\\", "\\\\")
  local code_line = 'dofile("' .. escaped_path .. '") -- RHMarkerManagerAutoStart'
  local content = ""
  local file = io.open(startup_path, "r")
  if file then content = file:read("*a"); file:close() end
  local new_content = ""
  for line in content:gmatch("[^\r\n]+") do
    if not line:match("RHMarkerManagerAutoStart") then
      new_content = new_content .. line .. "\n"
    end
  end
  if enable then new_content = new_content .. code_line .. "\n" end
  local f_out = io.open(startup_path, "w")
  if f_out then f_out:write(new_content); f_out:close() end
end

local function save_current_preset()
  set_ext("CurrentName", current_marker.name)
  set_ext("CurrentCharacterId", current_marker.character_id or "")
  local r, g, b = 0, 0, 0
  if current_marker.color then r, g, b = table.unpack(current_marker.color) end
  set_ext("CurrentColorNative", tostring(reaper_native_color(r, g, b)))
end

-- ============================================================
-- Send to server — reads REAPER's own current marker list, not any
-- internal Lua-side tracking, so anything visible in REAPER's native
-- Region/Marker Manager gets uploaded, including markers the sound
-- engineer edited/renamed directly there.
-- ============================================================
local function collect_markers_for_upload()
  local out = {}
  local i = 0
  while true do
    local retval, isrgn, pos, _rgnend, name, _idx, color = reaper.EnumProjectMarkers2(0, i)
    if retval == 0 then break end
    if not isrgn then
      local clean_name, char_id = strip_rh_suffix(name)
      out[#out + 1] = {
        reaper_name = clean_name,
        position_seconds = pos,
        confirmed = true,
        color = nil, -- server-side color isn't meaningful here (see color_for_id comment) — left unset
        character_id = char_id,
      }
    end
    i = i + 1
  end
  return out
end

-- Called after a "send" pending request resolves (see poll_pending).
local function finish_send(ok, status, count)
  if ok then
    send_status = "ok"
    send_status_detail = string.format("Надіслано %d маркер(ів)", count)
  else
    send_status = "error"
    send_status_detail = "Помилка відправки (код: " .. tostring(status) .. ")"
  end
  send_status_until = reaper.time_precise() + 5
end

-- Launches the upload WITHOUT blocking — result arrives later via
-- poll_pending().
local function send_to_server()
  if not selected_episode or pending then return end
  local markers = collect_markers_for_upload()
  if #markers == 0 then
    send_status = "error"
    send_status_detail = "Немає маркерів у проєкті для відправки"
    send_status_until = reaper.time_precise() + 4
    return
  end
  send_status = "sending"
  local handle = http_start("POST", WORKER_BASE .. "/shared-episodes/" .. selected_episode.id .. "/markers/add", markers, 20)
  pending = { kind = "send", handle = handle, count = #markers }
end

-- Polled every frame from main() — advances whatever request is currently
-- in flight (if any) without ever blocking REAPER itself.
local function poll_pending()
  if not pending then return end
  local state, ok, status, body = http_poll(pending.handle)
  if state == "pending" then return end
  if pending.kind == "snapshot" then
    finish_snapshot(state == "done" and ok, status, body)
  elseif pending.kind == "send" then
    finish_send(state == "done" and ok, status, pending.count)
  end
  pending = nil
end

-- ============================================================
-- UI drawing helpers (mirrors the reference script's own draw_button)
-- ============================================================
local function set_rgb(r, g, b, a) gfx.set(r / 255, g / 255, b / 255, a or 1) end

local function draw_button(x, y, w, h, text, is_hover, is_active, disabled)
  if disabled then set_rgb(26, 26, 26, 1)
  elseif is_active then set_rgb(0x7A, 0x12, 0x15, 1)
  elseif is_hover then set_rgb(0x4D, 0x4D, 0x4D, 1)
  else set_rgb(0x33, 0x33, 0x33, 1) end
  gfx.rect(x, y, w, h)
  if disabled then set_rgb(0x77, 0x77, 0x77, 1) else gfx.set(1, 1, 1, 1) end
  local text_w, text_h = gfx.measurestr(text)
  gfx.x = x + (w - text_w) / 2
  gfx.y = y + (h - text_h) / 2
  gfx.drawstr(text)
end

local function point_in(mx, my, x, y, w, h)
  return mx > x and mx < x + w and my > y and my < y + h
end

-- Status strip — 22px, always visible at the bottom. Matches the design's
-- 4 states, reworded for "server", not "the desktop app".
local function draw_status_strip(y, w)
  gfx.set(0.08, 0.08, 0.08, 1)
  gfx.rect(0, y, w, 22)
  local dot_r, dot_g, dot_b, border = 0, 0, 0, nil
  local text, sub = "", ""
  if conn_state == "connected" then
    dot_r, dot_g, dot_b = 0x1F, 0x7A, 0x1F
    text = selected_title and ("Підключено: " .. (selected_title.name_ua or "")) or "Підключено"
    sub = "raccoonhouse-signaling"
  elseif conn_state == "reconnecting" then
    dot_r, dot_g, dot_b = 0xB8, 0x86, 0x0B
    text = string.format("Перепідключення… спроба %d/%d", reconnect_attempt, RECONNECT_MAX_ATTEMPTS)
    sub = snapshot_is_cached and "показано кеш" or ""
  elseif conn_state == "cached" then
    dot_r, dot_g, dot_b = 0, 0, 0; border = { 0x80, 0x80, 0x80 }
    text = "Офлайн — кеш від " .. get_ext("SnapshotCacheAt", "?")
    sub = "маркери пишуться далі"
  elseif conn_state == "connecting" then
    dot_r, dot_g, dot_b = 0xB8, 0x86, 0x0B
    text = "З'єднання…"
  else
    dot_r, dot_g, dot_b = 0xE5, 0x21, 0x28
    text = conn_error_detail or "Немає з'єднання з сервером RaccoonHouse"
    sub = reconnect_attempt < RECONNECT_MAX_ATTEMPTS and ("спроба через " .. RECONNECT_INTERVAL .. " с") or "спроб вичерпано"
  end
  if border then
    gfx.set(0.08, 0.08, 0.08, 1); gfx.rect(6, y + 7, 8, 8)
    set_rgb(border[1], border[2], border[3], 1); gfx.rect(6, y + 7, 8, 8, 0)
  else
    set_rgb(dot_r, dot_g, dot_b, 1); gfx.rect(6, y + 7, 8, 8)
  end
  set_rgb(0xB8, 0xB8, 0xB8, 1)
  gfx.x, gfx.y = 20, y + 5
  gfx.drawstr(text)
  if sub ~= "" then
    set_rgb(0x66, 0x66, 0x66, 1)
    local sw = gfx.measurestr(sub)
    gfx.x, gfx.y = w - sw - 8, y + 5
    gfx.drawstr(sub)
  end
  if send_status and reaper.time_precise() < send_status_until then
    if send_status == "ok" then set_rgb(0x1A, 0x66, 0x1A, 1)
    elseif send_status == "error" then set_rgb(0xE5, 0x21, 0x28, 1)
    else set_rgb(0xB8, 0x86, 0x0B, 1) end
    gfx.x, gfx.y = 20, y + 5
    gfx.drawstr(send_status_detail or "")
  end
end

-- ============================================================
-- Screen: setup (first run only — enter team id once)
-- ============================================================
local function draw_setup_screen(mx, my, click)
  gfx.set(0, 0, 0, 1); gfx.rect(0, 0, gfx.w, gfx.h)
  set_rgb(0xCC, 0xCC, 0xCC, 1)
  gfx.x, gfx.y = 20, 20
  gfx.drawstr("Перше підключення — потрібен ID команди.")
  gfx.x, gfx.y = 20, 40
  gfx.drawstr("Скопіюйте його в RaccoonHouse Studio: Команди → «ID для Reaper».")
  local btn_hover = point_in(mx, my, 20, 80, 200, 32)
  draw_button(20, 80, 200, 32, "Ввести ID команди", btn_hover, false)
  if click and btn_hover then
    local retval, input = reaper.GetUserInputs("ID команди", 1, "ID команди:,extrawidth=200", "")
    if retval and input ~= "" then
      team_id = input:gsub("%s+", "")
      set_ext("TeamId", team_id)
      screen = "titles"
      fetch_snapshot()
    end
  end
end

-- ============================================================
-- Screen: titles list
-- ============================================================
local function draw_titles_screen(mx, my, click)
  gfx.set(0, 0, 0, 1); gfx.rect(0, 0, gfx.w, gfx.h)
  set_rgb(0xCC, 0xCC, 0xCC, 1)
  gfx.x, gfx.y = 10, 8
  gfx.drawstr("Оберіть тайтл:")

  local change_hover = point_in(mx, my, gfx.w - 90, 6, 80, 18)
  set_rgb(0x66, 0x66, 0x66, 1)
  if change_hover then set_rgb(0xAA, 0xAA, 0xAA, 1) end
  gfx.x, gfx.y = gfx.w - 90, 8
  gfx.drawstr("змінити ID")
  if click and change_hover then
    screen = "setup"
    return
  end

  if not snapshot then
    set_rgb(0x77, 0x77, 0x77, 1)
    gfx.x, gfx.y = 10, 40
    gfx.drawstr("Завантаження…")
    return
  end

  local y = 30
  for _, title in ipairs(snapshot) do
    local row_hover = point_in(mx, my, 10, y, gfx.w - 20, 28)
    if row_hover then set_rgb(0x33, 0x33, 0x33, 1); gfx.rect(10, y, gfx.w - 20, 28) end
    set_rgb(1, 1, 1, 1)
    gfx.x, gfx.y = 18, y + 6
    gfx.drawstr((title.name_ua or "") .. ((title.name_original or "") ~= "" and ("  ·  " .. title.name_original) or ""))
    set_rgb(0x66, 0x66, 0x66, 1)
    local ep_count = title.episodes and #title.episodes or 0
    local cnt_str = ep_count .. " еп."
    local cw = gfx.measurestr(cnt_str)
    gfx.x, gfx.y = gfx.w - 20 - cw, y + 6
    gfx.drawstr(cnt_str)
    if click and row_hover then
      selected_title = title
      screen = "episodes"
    end
    y = y + 30
  end
end

-- ============================================================
-- Screen: episode list (for the selected title)
-- ============================================================
local function draw_episodes_screen(mx, my, click)
  gfx.set(0, 0, 0, 1); gfx.rect(0, 0, gfx.w, gfx.h)
  local back_hover = point_in(mx, my, 10, 6, 60, 18)
  set_rgb(back_hover and 0xAA or 0x66, back_hover and 0xAA or 0x66, back_hover and 0xAA or 0x66, 1)
  gfx.x, gfx.y = 10, 8
  gfx.drawstr("← тайтли")
  if click and back_hover then screen = "titles"; return end

  set_rgb(0xCC, 0xCC, 0xCC, 1)
  gfx.x, gfx.y = 90, 8
  gfx.drawstr((selected_title.name_ua or "") .. " — серії:")

  local y = 30
  local episodes = selected_title.episodes or {}
  -- sort by season, number
  table.sort(episodes, function(a, b)
    if a.season ~= b.season then return (a.season or 0) < (b.season or 0) end
    return (a.number or 0) < (b.number or 0)
  end)
  for _, ep in ipairs(episodes) do
    local row_hover = point_in(mx, my, 10, y, gfx.w - 20, 28)
    if row_hover then set_rgb(0x33, 0x33, 0x33, 1); gfx.rect(10, y, gfx.w - 20, 28) end
    set_rgb(1, 1, 1, 1)
    gfx.x, gfx.y = 18, y + 6
    gfx.drawstr(string.format("Сезон %d, серія %d", ep.season or 1, ep.number or 0))
    if click and row_hover then
      selected_episode = ep
      screen = "manager"
      scroll_y = 0
    end
    y = y + 30
  end
  if #episodes == 0 then
    set_rgb(0x66, 0x66, 0x66, 1)
    gfx.x, gfx.y = 18, y
    gfx.drawstr("Серій ще немає")
  end
end

-- ============================================================
-- Screen: manager (main working view)
-- ============================================================
local function draw_manager_screen(mx, my, click)
  local strip_h = 22
  local content_h = gfx.h - strip_h
  gfx.set(0, 0, 0, 1); gfx.rect(0, 0, gfx.w, content_h)

  local narrow = gfx.w < 560
  local left_w, right_x, right_w

  if narrow then
    -- Tabs: single column, switch between marker preset and cast list.
    local tab_h = 20
    local tab_w = gfx.w / 2
    for idx, name in ipairs({ "marker", "cast" }) do
      local tx = (idx - 1) * tab_w
      local active = narrow_tab == name
      set_rgb(active and 0x33 or 0x1a, active and 0x33 or 0x1a, active and 0x33 or 0x1a, 1)
      gfx.rect(tx, 0, tab_w, tab_h)
      set_rgb(1, 1, 1, 1)
      local label = name == "marker" and "МАРКЕР" or "КАСТ"
      local lw = gfx.measurestr(label)
      gfx.x, gfx.y = tx + (tab_w - lw) / 2, 3
      gfx.drawstr(label)
      if click and point_in(mx, my, tx, 0, tab_w, tab_h) then narrow_tab = name end
    end
    left_w = gfx.w
    right_x, right_w = 0, gfx.w
  else
    left_w = math.floor(gfx.w / 2)
    right_x = left_w + 1
    right_w = gfx.w - left_w - 1
    set_rgb(0x4D, 0x4D, 0x4D, 1)
    gfx.line(left_w, 0, left_w, content_h)
  end

  local show_left = (not narrow) or narrow_tab == "marker"
  local show_right = (not narrow) or narrow_tab == "cast"
  local top_off = narrow and 20 or 0

  -- ---------------- LEFT: current marker preset ----------------
  if show_left then
    local px = 10
    local py = top_off + 10
    set_rgb(0xCC, 0xCC, 0xCC, 1)
    gfx.x, gfx.y = px, py
    gfx.drawstr("Назва маркера:")
    py = py + 20

    local name_hover = point_in(mx, my, px, py, left_w - 20, 26)
    set_rgb(0x33, 0x33, 0x33, 1); gfx.rect(px, py, left_w - 20, 26)
    set_rgb(0x4D, 0x4D, 0x4D, 1); gfx.rect(px, py, left_w - 20, 26, 0)
    set_rgb(1, 1, 1, 1)
    gfx.x, gfx.y = px + 8, py + 5
    gfx.drawstr(current_marker.name ~= "" and current_marker.name or "—")
    if click and name_hover then
      local retval, input = reaper.GetUserInputs("Назва маркера", 1, "Назва:,extrawidth=100", current_marker.name)
      if retval then current_marker.name = input end
    end
    py = py + 26

    set_rgb(0x7A, 0x7A, 0x7A, 1)
    gfx.x, gfx.y = px, py + 3
    gfx.drawstr(current_marker.character_id and ("character_id: " .. current_marker.character_id:sub(1, 8) .. "…")
      or "character_id: —")
    py = py + 20

    set_rgb(0xCC, 0xCC, 0xCC, 1)
    gfx.x, gfx.y = px, py
    gfx.drawstr("Колір:")
    py = py + 18

    local btn_w = 96
    local change_hover = point_in(mx, my, px, py, btn_w, 26)
    draw_button(px, py, btn_w, 26, "ЗМІНИТИ", change_hover, false)
    local r, g, b = 0x33, 0x33, 0x33
    if current_marker.color then r, g, b = table.unpack(current_marker.color) end
    set_rgb(r, g, b, 1)
    gfx.rect(px + btn_w + 6, py, left_w - 20 - btn_w - 6, 26)
    gfx.set(1, 1, 1, 1)
    gfx.rect(px + btn_w + 6, py, left_w - 20 - btn_w - 6, 26, 0)
    if click and change_hover then
      local ok, color = reaper.GR_SelectColor(0)
      if ok ~= 0 then
        local cr, cg, cb = reaper.ColorFromNative(color)
        current_marker.color = { cr, cg, cb }
        current_marker.overridden = true
      end
    end
    py = py + 26

    set_rgb(0x7A, 0x7A, 0x7A, 1)
    gfx.x, gfx.y = px, py + 3
    gfx.drawstr(current_marker.overridden and "Колір змінено вручну для цього пресету"
      or "Успадковано від персонажа")
    py = py + 24

    -- Preview of the literal name that will land in REAPER.
    set_rgb(0x14, 0x14, 0x14, 1)
    gfx.rect(px, py, left_w - 20, 40)
    set_rgb(0xE5, 0x21, 0x28, 1)
    gfx.rect(px, py, 3, 40)
    set_rgb(0x7A, 0x7A, 0x7A, 1)
    gfx.x, gfx.y = px + 10, py + 4
    gfx.drawstr("Буде створено на позиції курсора:")
    set_rgb(1, 1, 1, 1)
    gfx.x, gfx.y = px + 10, py + 20
    gfx.drawstr(compose_marker_name(current_marker.name ~= "" and current_marker.name or "Маркер", current_marker.character_id))
    py = py + 50

    -- Primary action + checkbox pinned near the bottom.
    local btn_y = math.max(py, content_h - 70)
    local add_hover = point_in(mx, my, px, btn_y, left_w - 20, 40)
    if action_created then
      set_rgb(0x1A, 0x66, 0x1A, 1)
      draw_button(px, btn_y, left_w - 20, 40, "ЗБЕРЕЖЕНО В ПАМ'ЯТЬ!", false, false)
    else
      draw_button(px, btn_y, left_w - 20, 40, "ЗБЕРЕГТИ ТА СТВОРИТИ ЕКШН", add_hover, add_hover)
      if click and add_hover then
        save_current_preset()
        if create_action_script() then action_created = true end
      end
    end

    local cb_y = btn_y + 50
    local cb_hover = point_in(mx, my, px, cb_y, 200, 15)
    if auto_start then set_rgb(0xE5, 0x21, 0x28, 1); gfx.rect(px, cb_y, 15, 15)
    else set_rgb(0, 0, 0, 1); gfx.rect(px, cb_y, 15, 15); gfx.set(1, 1, 1, 1); gfx.rect(px, cb_y, 15, 15, 0) end
    set_rgb(0xCC, 0xCC, 0xCC, 1)
    gfx.x, gfx.y = px + 25, cb_y
    gfx.drawstr("Автозапуск разом з REAPER")
    if click and cb_hover then
      auto_start = not auto_start
      set_ext("AutoStart", auto_start and "1" or "0")
      update_startup_script(auto_start)
    end
  end

  -- ---------------- RIGHT: cast list ----------------
  if show_right then
    local px = right_x + 10
    local py = top_off + 10
    local characters = (selected_title and selected_title.characters) or {}

    set_rgb(0xCC, 0xCC, 0xCC, 1)
    gfx.x, gfx.y = px, py
    gfx.drawstr("КАСТ ЕПІЗОДУ · " .. #characters)

    local dot_r, dot_g, dot_b = 0x1F, 0x7A, 0x1F
    local live_label = "LIVE"
    if conn_state == "cached" then dot_r, dot_g, dot_b = 0, 0, 0; live_label = "КЕШ"
    elseif conn_state ~= "connected" then dot_r, dot_g, dot_b = 0xB8, 0x86, 0x0B; live_label = "…" end
    set_rgb(dot_r, dot_g, dot_b, 1)
    local lw = gfx.measurestr(live_label)
    gfx.rect(right_x + right_w - 10 - lw - 12, py + 3, 7, 7)
    set_rgb(0x8F, 0xBF, 0x8F, 1)
    gfx.x, gfx.y = right_x + right_w - 10 - lw, py
    gfx.drawstr(live_label)
    py = py + 22

    local list_top = py
    local list_bottom = content_h - 30
    local row_h = 25
    local max_scroll = math.max(0, (#characters * row_h) - (list_bottom - list_top))
    if scroll_y > max_scroll then scroll_y = max_scroll end
    if scroll_y < 0 then scroll_y = 0 end

    for row_idx, char in ipairs(characters) do
      local cy = list_top + (row_idx - 1) * row_h - scroll_y
      if cy + row_h >= list_top and cy <= list_bottom then
        local is_active = current_marker.character_id == char.id
        local row_hover = point_in(mx, my, px, cy, right_w - 20, row_h)
        if is_active then
          set_rgb(0x5C, 0x0E, 0x11, 1); gfx.rect(px, cy, right_w - 20, row_h)
          set_rgb(0xE5, 0x21, 0x28, 1); gfx.rect(px, cy, 4, row_h)
        elseif row_hover then
          set_rgb(0x4D, 0x4D, 0x4D, 1); gfx.rect(px, cy, right_w - 20, row_h)
        else
          set_rgb(0x26, 0x26, 0x26, 1); gfx.rect(px, cy, right_w - 20, row_h)
        end
        local cr, cg, cb = color_for_id(char.id)
        set_rgb(cr, cg, cb, 1)
        gfx.rect(px + (is_active and 8 or 12), cy + 5, 15, 15)
        gfx.set(1, 1, 1, 1)
        gfx.rect(px + (is_active and 8 or 12), cy + 5, 15, 15, 0)
        set_rgb(1, 1, 1, 1)
        gfx.x, gfx.y = px + (is_active and 8 or 12) + 23, cy + 5
        gfx.drawstr(char.name or "?")
        set_rgb(0x99, 0x99, 0x99, 1)
        local idshort = (char.id or ""):sub(1, 8)
        local iw = gfx.measurestr(idshort)
        gfx.x, gfx.y = px + right_w - 20 - iw - 4, cy + 5
        gfx.drawstr(idshort)
        if click and row_hover then
          current_marker.character_id = char.id
          current_marker.character_name = char.name
          if not current_marker.overridden then
            local cr2, cg2, cb2 = color_for_id(char.id)
            current_marker.color = { cr2, cg2, cb2 }
          end
          if current_marker.name == "" or current_marker.name == current_marker.character_name then
            current_marker.name = char.name
          end
          current_marker.overridden = false
          action_created = false
        end
      end
    end

    local refresh_busy = pending ~= nil
    local refresh_hover = (not refresh_busy) and point_in(mx, my, px, list_bottom + 4, right_w - 20, 22)
    draw_button(px, list_bottom + 4, right_w - 20, 22, refresh_busy and "…" or "ОНОВИТИ СПИСОК", refresh_hover, false, refresh_busy)
    if click and refresh_hover then fetch_snapshot() end
  end

  -- ---------------- Send-to-server (bottom-right of manager, above strip) ----------------
  local send_w = 180
  local send_busy = pending ~= nil and pending.kind == "send"
  local send_hover = (not send_busy) and point_in(mx, my, gfx.w - send_w - 10, content_h - 26, send_w, 22)
  draw_button(gfx.w - send_w - 10, content_h - 26, send_w, 22, send_busy and "ВІДПРАВЛЯЄТЬСЯ…" or "ВІДПРАВИТИ НА СЕРВЕР", send_hover, send_hover, send_busy)
  if click and send_hover then send_to_server() end

  draw_status_strip(content_h, gfx.w)
end

-- ============================================================
-- Main loop
-- ============================================================
local function init()
  gfx.init("Менеджер Маркерів — RaccoonHouse", saved_w, saved_h, saved_dock)
  gfx.setfont(1, "Arial", 16)
  if screen == "titles" and not snapshot then fetch_snapshot() end
end

local function main()
  local char = gfx.getchar()
  if char == -1 or char == 27 then return end

  if gfx.w ~= saved_w or gfx.h ~= saved_h or gfx.dock(-1) ~= saved_dock then
    saved_w, saved_h = gfx.w, gfx.h
    saved_dock = gfx.dock(-1)
    set_ext("WinW", saved_w)
    set_ext("WinH", saved_h)
    set_ext("Dock", saved_dock)
  end

  local mx, my = gfx.mouse_x, gfx.mouse_y
  local mc = (gfx.mouse_cap & 1 == 1)
  local click = mc and (last_mouse_state == 0)

  if gfx.mouse_wheel ~= 0 then
    scroll_y = scroll_y - (gfx.mouse_wheel / 120) * 30
    gfx.mouse_wheel = 0
  end

  poll_pending() -- advance any in-flight request; never blocks

  -- Only auto-retry while looking at a screen that actually needs live data.
  if screen == "titles" or screen == "manager" then
    maybe_retry()
  end

  if screen == "setup" then
    draw_setup_screen(mx, my, click)
  elseif screen == "titles" then
    draw_titles_screen(mx, my, click)
  elseif screen == "episodes" then
    draw_episodes_screen(mx, my, click)
  elseif screen == "manager" then
    draw_manager_screen(mx, my, click)
  end

  last_mouse_state = mc and 1 or 0
  gfx.update()
  reaper.defer(main)
end

init()
main()
