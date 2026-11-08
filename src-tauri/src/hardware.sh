# Werkterm: system and hardware overview (read-only, no root needed).
# Prints "Key=Value" lines grouped by topic; missing tools or unreadable files are skipped.
LC_ALL=C; export LC_ALL
K='\033[35m'; H='\033[1;33m'; R='\033[0m'
kv() { [ -n "$2" ] && printf "${K}%s${R}=%s\n" "$1" "$2"; }
head1() { printf "\n${H}%s${R}\n" "$1"; }
rd() { [ -r "$1" ] && v=$(cat "$1" 2>/dev/null) && [ -n "$v" ] && printf '%s' "$v"; }

head1 "System"
kv ComputerName "$(uname -n)"
if [ -r /etc/os-release ]; then . /etc/os-release; kv OperatingSystem "${PRETTY_NAME:-$NAME}"; fi
kv Kernel "$(uname -sr)"
kv Architecture "$(uname -m)"
if [ -r /proc/uptime ]; then
  s=$(cut -d. -f1 /proc/uptime); d=$((s / 86400)); h=$((s % 86400 / 3600)); m=$((s % 3600 / 60))
  kv Uptime "${d}d ${h}h ${m}min"
fi
kv UserName "$(id -un)"
if [ "$(id -u)" = 0 ]; then kv IsRoot yes; else kv IsRoot no; fi
kv Virtualization "$(command -v systemd-detect-virt >/dev/null 2>&1 && systemd-detect-virt 2>/dev/null)"

head1 "CPU"
if [ -r /proc/cpuinfo ]; then
  kv CPUName "$(grep -m1 '^model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//')"
  kv CPUVendor "$(grep -m1 '^vendor_id' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//')"
  kv CPUFrequency "$(grep -m1 '^cpu MHz' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//; s/\..*//') MHz"
fi
kv CPUThreads "$(nproc 2>/dev/null)"
kv CPUSockets "$(grep '^physical id' /proc/cpuinfo 2>/dev/null | sort -u | wc -l | sed 's/^0$//')"

head1 "Memory"
if [ -r /proc/meminfo ]; then
  mem() { awk -v k="$1" '$1 == k":" { printf "%d MB", $2 / 1024 }' /proc/meminfo; }
  kv MemTotal "$(mem MemTotal)"; kv MemAvailable "$(mem MemAvailable)"
  kv SwapTotal "$(mem SwapTotal)"; kv SwapFree "$(mem SwapFree)"
fi

hw=$(
D=/sys/class/dmi/id
kv Manufacturer "$(rd $D/sys_vendor)"
kv ProductName "$(rd $D/product_name)"
kv ProductVersion "$(rd $D/product_version)"
kv MotherBoardManufacturer "$(rd $D/board_vendor)"
kv MotherBoardProductName "$(rd $D/board_name)"
kv BIOSVendor "$(rd $D/bios_vendor)"
kv BIOSVersion "$(rd $D/bios_version)"
kv BIOSDate "$(rd $D/bios_date)"
# Serial numbers are root-only on Linux; shown only when already readable.
kv SerialNumber "$(rd $D/product_serial)"
kv MotherBoardSerial "$(rd $D/board_serial)"
if command -v lspci >/dev/null 2>&1; then
  lspci 2>/dev/null | grep -E 'VGA|3D|Display' | cut -d: -f3- | sed 's/^ *//' | while read -r gpu; do kv GPU "$gpu"; done
fi
)
if [ -n "$hw" ]; then head1 "Hardware"; printf '%s\n' "$hw"; fi

head1 "Disks"
df -h -P -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null | awk 'NR > 1 { printf "\033[35mPartition_%s\033[0m=%s used of %s (%s)\n", $6, $3, $2, $5 }'

head1 "Network"
if command -v ip >/dev/null 2>&1; then
  ip -br addr 2>/dev/null | awk '$1 != "lo" && NF >= 3 { ips = ""; for (i = 3; i <= NF; i++) ips = ips (ips ? " " : "") $i; printf "\033[35mIpAddress_%s\033[0m=%s\n", $1, ips }'
  ip -br link 2>/dev/null | awk '$1 != "lo" && $3 ~ /^[0-9a-f:]+$/ && $3 != "00:00:00:00:00:00" { printf "\033[35mMacAddress_%s\033[0m=%s\n", $1, $3 }'
  kv DefaultGateway "$(ip route 2>/dev/null | awk '/^default/ { print $3; exit }')"
fi
kv DNSServer "$(awk '/^nameserver/ { printf "%s%s", sep, $2; sep = " " }' /etc/resolv.conf 2>/dev/null)"
printf '\n'
