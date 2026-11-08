# Werkterm: read-only hardware overview, compatible with Windows PowerShell 5.1.
$esc = [char]27
function Write-Kv($key, $value) {
    if ($null -ne $value -and "$value".Trim()) { Write-Output "${esc}[35m${key}${esc}[0m=$value" }
}
function Write-Heading($title) { Write-Output "`n${esc}[1;33m${title}${esc}[0m" }
function Format-Size([double]$bytes) {
    $units = @('B', 'K', 'M', 'G', 'T', 'P')
    $unit = 0
    while ($bytes -ge 1024 -and $unit -lt ($units.Length - 1)) { $bytes /= 1024; $unit++ }
    return ('{0:0.#}{1}' -f $bytes, $units[$unit])
}
$computer = $null
$os = $null
try { $computer = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue } catch {}
try { $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue } catch {}

Write-Heading 'System'
Write-Kv ComputerName $env:COMPUTERNAME
if ($os) {
    Write-Kv OperatingSystem ("{0} {1} (Build {2})" -f $os.Caption, $os.Version, $os.BuildNumber)
    Write-Kv Kernel $os.Version
    Write-Kv Architecture $os.OSArchitecture
    try {
        if ($os.LastBootUpTime) {
            $uptime = (Get-Date -ErrorAction SilentlyContinue) - $os.LastBootUpTime
            Write-Kv Uptime ("{0}d {1}h {2}min" -f $uptime.Days, $uptime.Hours, $uptime.Minutes)
        }
    } catch {}
}
Write-Kv UserName $env:USERNAME
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = New-Object Security.Principal.WindowsPrincipal($identity) -ErrorAction SilentlyContinue
        if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Kv IsRoot yes } else { Write-Kv IsRoot no }
    } finally { $identity.Dispose() }
} catch {}
# HypervisorPresent is also true on physical hosts with Hyper-V or VBS, so only the model identifies a VM.
if ($computer -and ("$($computer.Manufacturer) $($computer.Model)" -match 'Virtual Machine|VMware|VirtualBox|KVM|QEMU|Xen|Parallels|Bochs')) {
    Write-Kv Virtualization $computer.Model
}

Write-Heading 'CPU'
try {
    $processors = @(Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue)
    if ($processors.Count) {
        Write-Kv CPUName (($processors | ForEach-Object { $_.Name } | Select-Object -Unique) -join '; ')
        Write-Kv CPUVendor (($processors | ForEach-Object { $_.Manufacturer } | Select-Object -Unique) -join '; ')
        Write-Kv CPUFrequency (($processors | ForEach-Object { "$($_.MaxClockSpeed) MHz" }) -join '; ')
        Write-Kv CPUThreads (($processors | Measure-Object NumberOfLogicalProcessors -Sum).Sum)
        Write-Kv CPUSockets $processors.Count
    }
} catch {}

Write-Heading 'Memory'
if ($computer -and $null -ne $computer.TotalPhysicalMemory) { Write-Kv MemTotal ("{0} MB" -f [math]::Floor($computer.TotalPhysicalMemory / 1MB)) }
if ($os) {
    foreach ($entry in @(@('MemAvailable', 'FreePhysicalMemory'), @('SwapTotal', 'SizeStoredInPagingFiles'), @('SwapFree', 'FreeSpaceInPagingFiles'))) {
        if ($null -ne $os.($entry[1])) { Write-Kv $entry[0] ("{0} MB" -f [math]::Floor($os.($entry[1]) / 1024)) }
    }
}

Write-Heading 'Hardware'
try {
    $product = Get-CimInstance Win32_ComputerSystemProduct -ErrorAction SilentlyContinue
    Write-Kv Manufacturer $product.Vendor
    Write-Kv ProductName $product.Name
    Write-Kv ProductVersion $product.Version
    Write-Kv SerialNumber $product.IdentifyingNumber
} catch {}
try {
    $board = Get-CimInstance Win32_BaseBoard -ErrorAction SilentlyContinue
    Write-Kv MotherBoardManufacturer $board.Manufacturer
    Write-Kv MotherBoardProductName $board.Product
    Write-Kv MotherBoardSerial $board.SerialNumber
} catch {}
try {
    $bios = Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue
    Write-Kv BIOSVendor $bios.Manufacturer
    Write-Kv BIOSVersion $bios.SMBIOSBIOSVersion
    if ($bios.ReleaseDate) { Write-Kv BIOSDate ($bios.ReleaseDate.ToString('yyyy-MM-dd')) }
} catch {}
try { Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object { Write-Kv GPU $_.Name } } catch {}

Write-Heading 'Disks'
try {
    Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Size -gt 0 -and $null -ne $_.FreeSpace) {
            $used = $_.Size - $_.FreeSpace
            Write-Kv "Partition_$($_.DeviceID)" ("{0} used of {1} ({2}%)" -f (Format-Size $used), (Format-Size $_.Size), [math]::Round(100 * $used / $_.Size))
        }
    }
} catch {}

Write-Heading 'Network'
# Only adapters that are up, like "ip -br" without DOWN interfaces.
$up = @()
try { $up = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up') } catch {}
try {
    Get-NetIPAddress -ErrorAction SilentlyContinue | Where-Object {
        ($up.Name -contains $_.InterfaceAlias) -and $_.IPAddress -and $_.IPAddress -ne '::1' -and $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'
    } | Group-Object InterfaceAlias | ForEach-Object {
        Write-Kv "IpAddress_$($_.Name)" (($_.Group | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" }) -join ' ')
    }
} catch {}
$up | ForEach-Object { Write-Kv "MacAddress_$($_.Name)" $_.MacAddress }
try {
    $gateways = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | ForEach-Object { $_.NextHop } | Select-Object -Unique)
    Write-Kv DefaultGateway ($gateways -join ' ')
} catch {}

Write-Heading 'DNS'
try {
    $servers = @(Get-DnsClientServerAddress -ErrorAction SilentlyContinue | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ } | Select-Object -Unique)
    Write-Kv DNSServer ($servers -join ' ')
} catch {}
Write-Output ''
