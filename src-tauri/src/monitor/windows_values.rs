use super::Disk;

pub(super) fn windows_memory(
    total_phys: u64,
    avail_phys: u64,
    cache_pages: Option<(usize, usize)>,
) -> (u64, u64, Option<u64>, Option<u64>) {
    let cached =
        cache_pages.and_then(|(pages, page_size)| (pages as u64).checked_mul(page_size as u64));
    (
        total_phys.saturating_sub(avail_phys),
        total_phys,
        Some(avail_phys),
        cached,
    )
}

pub(super) fn disk_usage(device: String, mount: String, total: u64, free: u64) -> Disk {
    let used = total.saturating_sub(free);
    let used_percent = if total == 0 {
        0
    } else {
        (u128::from(used) * 100).div_ceil(u128::from(total)) as u32
    };
    Disk {
        device,
        mount,
        used_bytes: used,
        free_bytes: free,
        size_bytes: total,
        used_percent,
    }
}

pub(super) type CpuTimes = (u64, u64, u64);

pub(super) fn cpu_from_times(prev: CpuTimes, cur: CpuTimes) -> Option<(f32, Vec<f32>)> {
    let idle = cur.0.checked_sub(prev.0)?;
    let kernel = cur.1.checked_sub(prev.1)?;
    let user = cur.2.checked_sub(prev.2)?;
    let system = kernel.checked_sub(idle)?;
    let total = kernel.checked_add(user)?;
    if total == 0 {
        return None;
    }
    let percent = |ticks| (100.0 * ticks as f64 / total as f64) as f32;
    Some((
        percent(system + user),
        vec![percent(user), 0.0, percent(system), percent(idle)],
    ))
}

pub(super) fn windows_version(
    product_name: Option<String>,
    build: Option<u32>,
    ubr: Option<u32>,
) -> (Option<String>, Option<String>) {
    let name = product_name.map(|name| {
        if build.is_some_and(|build| build >= 22000) {
            name.replacen("Windows 10", "Windows 11", 1)
        } else {
            name
        }
    });
    let version = build
        .zip(ubr)
        .map(|(build, ubr)| format!("10.0.{build}.{ubr}"));
    (name, version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_stays_in_bytes_and_cache_pages_are_checked() {
        assert_eq!(
            windows_memory(17_179_869_184, 6_442_450_944, Some((262_144, 4096))),
            (
                10_737_418_240,
                17_179_869_184,
                Some(6_442_450_944),
                Some(1_073_741_824)
            )
        );
        assert_eq!(windows_memory(1, 2, None), (0, 1, Some(2), None));
        #[cfg(target_pointer_width = "64")]
        assert_eq!(windows_memory(1, 1, Some((usize::MAX, 4096))).3, None);
    }

    #[test]
    fn disks_keep_bytes_and_round_up_without_overflow() {
        let disk = disk_usage("C:\\".into(), "C:".into(), u64::MAX, 1);
        assert_eq!(disk.size_bytes, u64::MAX);
        assert_eq!(disk.used_bytes, u64::MAX - 1);
        assert_eq!(disk.free_bytes, 1);
        assert_eq!(disk.used_percent, 100);
        assert_eq!(
            disk_usage(String::new(), String::new(), 3, 2).used_percent,
            34
        );
        assert_eq!(
            disk_usage(String::new(), String::new(), 0, 1).used_percent,
            0
        );
    }

    #[test]
    fn cpu_subtracts_idle_from_kernel_and_rejects_bad_counters() {
        assert_eq!(
            cpu_from_times((10, 20, 30), (30, 70, 80)),
            Some((80.0, vec![50.0, 0.0, 30.0, 20.0]))
        );
        assert!(cpu_from_times((10, 20, 30), (10, 20, 30)).is_none());
        assert!(cpu_from_times((10, 20, 30), (11, 20, 40)).is_none());
        assert!(cpu_from_times((10, 20, 30), (9, 30, 40)).is_none());
        assert!(cpu_from_times((0, 0, 0), (0, u64::MAX, 1)).is_none());
    }

    #[test]
    fn build_corrects_product_name_and_missing_values_stay_optional() {
        assert_eq!(
            windows_version(Some("Windows 10 Pro".into()), Some(22000), Some(42)),
            (Some("Windows 11 Pro".into()), Some("10.0.22000.42".into()))
        );
        assert_eq!(
            windows_version(Some("Windows 10 Pro".into()), Some(21999), None),
            (Some("Windows 10 Pro".into()), None)
        );
        assert_eq!(windows_version(None, None, None), (None, None));
    }
}
