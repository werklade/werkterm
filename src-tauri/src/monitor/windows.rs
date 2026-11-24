use crate::monitor::{
    Disk, MonitorSample, Network, network_rates,
    windows_values::{CpuTimes, cpu_from_times, disk_usage, windows_memory, windows_version},
};
use std::{
    env,
    mem::size_of,
    ptr, slice,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use windows_sys::{
    Win32::{
        Foundation::{ERROR_SUCCESS, FILETIME},
        NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_ROW2, MIB_IF_TABLE2},
        Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives},
        System::{
            Diagnostics::Debug::{
                SEM_FAILCRITICALERRORS, SEM_NOOPENFILEERRORBOX, SetThreadErrorMode,
            },
            ProcessStatus::{GetPerformanceInfo, PERFORMANCE_INFORMATION},
            Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegGetValueW},
            SystemInformation::{GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX},
            Threading::GetSystemTimes,
        },
    },
    w,
};

pub(super) fn sample(stop: mpsc::Receiver<()>, mut send: impl FnMut(MonitorSample) -> bool) {
    // SAFETY: the previous mode is optional, and this dedicated thread never needs it restored.
    unsafe {
        SetThreadErrorMode(
            SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX,
            ptr::null_mut(),
        )
    };
    let (os_name, version) = os_version();
    let who: Vec<_> = env::var("USERNAME")
        .ok()
        .map(|user| format!("{user} console"))
        .into_iter()
        .collect();
    let base = MonitorSample {
        host: env::var("COMPUTERNAME").unwrap_or_default(),
        os_id: Some("windows".into()),
        os_name,
        version,
        cpu_cores: thread::available_parallelism()
            .ok()
            .and_then(|n| u32::try_from(n.get()).ok()),
        users: (!who.is_empty()).then_some(1),
        who,
        ..Default::default()
    };
    let mut previous_cpu = None;
    let mut previous_network: Option<(Instant, Vec<Network>)> = None;
    while matches!(stop.try_recv(), Err(mpsc::TryRecvError::Empty)) {
        let started = Instant::now();
        let mut current = base.clone();
        let cpu = system_times();
        if let Some((percent, parts)) = previous_cpu
            .zip(cpu)
            .and_then(|(prev, cur)| cpu_from_times(prev, cur))
        {
            current.cpu_percent = Some(percent);
            current.cpu_parts = parts;
        }
        previous_cpu = cpu;

        // SAFETY: this function takes no arguments and has no caller preconditions.
        current.uptime_secs = unsafe { GetTickCount64() } / 1000;
        (
            current.mem_used,
            current.mem_total,
            current.mem_available,
            current.cached,
        ) = memory();

        let network_time = Instant::now();
        current.interfaces = interfaces();
        if let Some((previous_time, previous)) = &previous_network {
            let elapsed = network_time.duration_since(*previous_time).as_secs_f64();
            if elapsed > 0.0 {
                network_rates(&mut current, previous, elapsed);
            }
        }
        previous_network = Some((network_time, current.interfaces.clone()));

        current.disks = disks();
        current.df_all = current.disks.clone();
        if !matches!(stop.try_recv(), Err(mpsc::TryRecvError::Empty)) || !send(current) {
            break;
        }
        if !matches!(
            stop.recv_timeout(Duration::from_secs(2).saturating_sub(started.elapsed())),
            Err(mpsc::RecvTimeoutError::Timeout)
        ) {
            break;
        }
    }
}

fn system_times() -> Option<CpuTimes> {
    let mut idle = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: all three arguments point to writable FILETIME values.
    let ok = unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) };
    let ticks =
        |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
    (ok != 0).then(|| (ticks(idle), ticks(kernel), ticks(user)))
}

fn memory() -> (u64, u64, Option<u64>, Option<u64>) {
    let mut physical = MEMORYSTATUSEX {
        dwLength: size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    let mut performance = PERFORMANCE_INFORMATION {
        cb: size_of::<PERFORMANCE_INFORMATION>() as u32,
        ..Default::default()
    };
    let performance_size = performance.cb;
    // SAFETY: both pointers are writable and the size fields describe their allocations.
    let physical_ok = unsafe { GlobalMemoryStatusEx(&mut physical) } != 0;
    let cache_ok = unsafe { GetPerformanceInfo(&mut performance, performance_size) } != 0;
    let cache = cache_ok.then_some((performance.SystemCache, performance.PageSize));
    if !physical_ok {
        return (0, 0, None, windows_memory(0, 0, cache).3);
    }
    windows_memory(physical.ullTotalPhys, physical.ullAvailPhys, cache)
}

const CURRENT_VERSION: *const u16 = w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion");

fn registry_string(name: *const u16) -> Option<String> {
    let mut buffer = [0u16; 256];
    let mut bytes = size_of::<[u16; 256]>() as u32;
    // SAFETY: both input strings are static and terminated. bytes describes the writable buffer.
    let result = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            CURRENT_VERSION,
            name,
            RRF_RT_REG_SZ,
            ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    (result == ERROR_SUCCESS).then(|| wide_string(&buffer))
}

fn os_version() -> (Option<String>, Option<String>) {
    let mut ubr = 0u32;
    let mut bytes = size_of::<u32>() as u32;
    // SAFETY: the input strings are terminated and ubr points to a writable DWORD.
    let result = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            CURRENT_VERSION,
            w!("UBR"),
            RRF_RT_REG_DWORD,
            ptr::null_mut(),
            (&mut ubr as *mut u32).cast(),
            &mut bytes,
        )
    };
    windows_version(
        registry_string(w!("ProductName")),
        registry_string(w!("CurrentBuildNumber")).and_then(|build| build.parse().ok()),
        (result == ERROR_SUCCESS).then_some(ubr),
    )
}

fn wide_string(buffer: &[u16]) -> String {
    let len = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..len])
}

struct InterfaceTable(*mut MIB_IF_TABLE2);

impl Drop for InterfaceTable {
    fn drop(&mut self) {
        // SAFETY: this pointer was allocated by a successful GetIfTable2.
        unsafe { FreeMibTable(self.0.cast()) };
    }
}

fn interfaces() -> Vec<Network> {
    let mut table = ptr::null_mut();
    // SAFETY: table is a writable out-pointer.
    if unsafe { GetIfTable2(&mut table) } != ERROR_SUCCESS || table.is_null() {
        return Vec::new();
    }
    let table = InterfaceTable(table);
    // SAFETY: the OS allocates NumEntries initialized rows at the variable-length Table field.
    // The guard keeps the allocation live until the rows have been copied.
    let rows: &[MIB_IF_ROW2] = unsafe {
        slice::from_raw_parts(
            ptr::addr_of!((*table.0).Table).cast(),
            (*table.0).NumEntries as usize,
        )
    };
    const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;
    const IF_OPER_STATUS_UP: i32 = 1;
    const FILTER_INTERFACE: u8 = 1 << 1;
    rows.iter()
        .filter(|row| {
            row.Type != IF_TYPE_SOFTWARE_LOOPBACK
                && row.OperStatus == IF_OPER_STATUS_UP
                && row.InterfaceAndOperStatusFlags._bitfield & FILTER_INTERFACE == 0
                && (row.InOctets != 0 || row.OutOctets != 0)
        })
        .map(|row| Network {
            name: wide_string(&row.Alias),
            rx: row.InOctets,
            tx: row.OutOctets,
            rx_errors: row.InErrors,
            tx_errors: row.OutErrors,
            rx_drop: row.InDiscards,
            tx_drop: row.OutDiscards,
            rx_rate: None,
            tx_rate: None,
        })
        .collect()
}

fn disks() -> Vec<Disk> {
    // SAFETY: this function takes no arguments and has no caller preconditions.
    let drives = unsafe { GetLogicalDrives() };
    (b'A'..=b'Z')
        .filter(|letter| drives & (1 << (letter - b'A')) != 0)
        .filter_map(drive_usage)
        .collect()
}

fn drive_usage(letter: u8) -> Option<Disk> {
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    let root = [u16::from(letter), b':' as u16, b'\\' as u16, 0];
    // SAFETY: root is a NUL-terminated drive root.
    if !matches!(
        unsafe { GetDriveTypeW(root.as_ptr()) },
        DRIVE_FIXED | DRIVE_REMOVABLE
    ) {
        return None;
    }
    let (mut total, mut free) = (0, 0);
    // SAFETY: root is terminated, both byte counts are writable, and caller-free bytes is optional.
    let ok = unsafe { GetDiskFreeSpaceExW(root.as_ptr(), ptr::null_mut(), &mut total, &mut free) };
    (ok != 0).then(|| {
        let letter = char::from(letter);
        disk_usage(format!("{letter}:\\"), format!("{letter}:"), total, free)
    })
}
