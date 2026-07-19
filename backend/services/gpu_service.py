"""
GPU/VRAM detection for the power-sharing "total power" view.

Win32_VideoController's AdapterRAM is a 32-bit field and famously wraps/misreports
for any GPU with >4GB VRAM (e.g. reports ~4GB for an 8GB card) — verified on this
machine's RTX 4060 (reports 4293918720 bytes via WMI vs. the correct 8585740288
via the registry). So the registry's HardwareInformation.qwMemorySize is used as
the primary source, with WMI as a fallback only if the registry read fails.
"""
import json
import subprocess

_REGISTRY_SCRIPT = r"""
$ErrorActionPreference = 'SilentlyContinue'
$best = $null
$paths = Get-ChildItem "HKLM:\SYSTEM\ControlSet001\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
foreach ($p in $paths) {
  $name = (Get-ItemProperty -Path $p.PSPath -Name "DriverDesc")."DriverDesc"
  $mem = (Get-ItemProperty -Path $p.PSPath -Name "HardwareInformation.qwMemorySize")."HardwareInformation.qwMemorySize"
  if ($name -and $mem -and ($null -eq $best -or $mem -gt $best.mem)) {
    $best = [PSCustomObject]@{ name = $name; mem = $mem }
  }
}
if ($best) { $best | ConvertTo-Json -Compress } else { "null" }
"""

_WMI_FALLBACK_SCRIPT = r"""
$ErrorActionPreference = 'SilentlyContinue'
$gpu = Get-CimInstance Win32_VideoController | Sort-Object AdapterRAM -Descending | Select-Object -First 1
if ($gpu) { [PSCustomObject]@{ name = $gpu.Name; mem = $gpu.AdapterRAM } | ConvertTo-Json -Compress } else { "null" }
"""


def _run_ps(script: str) -> dict | None:
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=10,
        )
        data = json.loads(result.stdout.strip() or "null")
        return data
    except Exception:
        return None


def get_gpu_info() -> dict:
    data = _run_ps(_REGISTRY_SCRIPT) or _run_ps(_WMI_FALLBACK_SCRIPT)
    if not data or not data.get("name"):
        return {"name": "Невідома відеокарта", "vram_gb": 0.0}
    return {
        "name": data["name"],
        "vram_gb": round(data.get("mem", 0) / (1024 ** 3), 1),
    }
