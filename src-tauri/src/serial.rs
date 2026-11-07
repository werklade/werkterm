use crate::telnet::{Message, Output};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tauri::ipc::{Channel, InvokeResponseBody};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SerialConfig {
    pub device: String,
    pub baud: u32,
    pub data_bits: u8,
    pub parity: String,
    pub stop_bits: u8,
    pub flow: String,
    pub enter: String,
    pub local_echo: bool,
}
impl Default for SerialConfig {
    fn default() -> Self {
        Self {
            device: String::new(),
            baud: 115200,
            data_bits: 8,
            parity: "none".into(),
            stop_bits: 1,
            flow: "none".into(),
            enter: "cr".into(),
            local_echo: false,
        }
    }
}
impl SerialConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.device.trim().is_empty() || self.device.chars().any(char::is_control) {
            return Err("Serielles Gerät fehlt oder ist ungültig".into());
        }
        if self.baud == 0
            || !(5..=8).contains(&self.data_bits)
            || !matches!(self.parity.as_str(), "none" | "odd" | "even")
            || !matches!(self.stop_bits, 1 | 2)
            || !matches!(self.flow.as_str(), "none" | "software" | "hardware")
            || !matches!(self.enter.as_str(), "cr" | "lf" | "crlf")
        {
            return Err("Ungültige serielle Parameter".into());
        }
        Ok(())
    }
    fn parameters(
        &self,
    ) -> (
        serialport::DataBits,
        serialport::Parity,
        serialport::StopBits,
        serialport::FlowControl,
    ) {
        (
            match self.data_bits {
                5 => serialport::DataBits::Five,
                6 => serialport::DataBits::Six,
                7 => serialport::DataBits::Seven,
                _ => serialport::DataBits::Eight,
            },
            match self.parity.as_str() {
                "odd" => serialport::Parity::Odd,
                "even" => serialport::Parity::Even,
                _ => serialport::Parity::None,
            },
            if self.stop_bits == 2 {
                serialport::StopBits::Two
            } else {
                serialport::StopBits::One
            },
            match self.flow.as_str() {
                "software" => serialport::FlowControl::Software,
                "hardware" => serialport::FlowControl::Hardware,
                _ => serialport::FlowControl::None,
            },
        )
    }
    fn builder(&self) -> serialport::SerialPortBuilder {
        let (data_bits, parity, stop_bits, flow) = self.parameters();
        serialport::new(&self.device, self.baud)
            .timeout(Duration::from_millis(100))
            .data_bits(data_bits)
            .parity(parity)
            .stop_bits(stop_bits)
            .flow_control(flow)
    }
}
pub fn input(bytes: &[u8], enter: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for &b in bytes {
        if b == 13 {
            out.extend(match enter {
                "lf" => b"\n".as_slice(),
                "crlf" => b"\r\n".as_slice(),
                _ => b"\r".as_slice(),
            });
        } else {
            out.push(b);
        }
    }
    out
}
pub fn echo(bytes: &[u8], enabled: bool) -> Vec<u8> {
    if enabled { bytes.to_vec() } else { vec![] }
}
// Never drain queued data after close; every port operation uses its 100 ms timeout.
fn write_interruptible(
    writer: &mut impl Write,
    mut bytes: &[u8],
    stop: &std::sync::atomic::AtomicBool,
) -> std::io::Result<bool> {
    while !bytes.is_empty() {
        if stop.load(Ordering::Acquire) {
            return Ok(false);
        }
        match writer.write(&bytes[..bytes.len().min(256)]) {
            Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
            Ok(n) => bytes = &bytes[n..],
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::Interrupted
                ) =>
            {
                // Also avoid spinning when a driver returns WouldBlock immediately.
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(!stop.load(Ordering::Acquire))
}
pub fn error_text(device: &str, kind: serialport::ErrorKind) -> String {
    match kind {
        serialport::ErrorKind::Io(std::io::ErrorKind::PermissionDenied) => {
            if cfg!(target_os = "linux") {
                format!(
                    "Keine Berechtigung für {device}. Benutzer zur Gruppe dialout hinzufügen (sudo usermod -aG dialout $USER) und neu anmelden."
                )
            } else {
                format!("Keine Berechtigung für {device}")
            }
        }
        serialport::ErrorKind::Io(
            std::io::ErrorKind::ResourceBusy
            | std::io::ErrorKind::AlreadyExists
            | std::io::ErrorKind::AddrInUse,
        ) => "Gerät wird bereits verwendet".into(),
        serialport::ErrorKind::NoDevice
        | serialport::ErrorKind::Io(
            std::io::ErrorKind::NotFound
            | std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::UnexpectedEof,
        ) => format!("Gerät {device} nicht verfügbar oder entfernt"),
        _ => format!("Serieller Fehler bei {device}: {kind:?}"),
    }
}
/// serialport maps Linux EBUSY and advisory lock failures to NoDevice.
/// Preserve that distinction before the original description is discarded.
fn open_error(device: &str, error: &serialport::Error) -> String {
    let detail = error.to_string().to_ascii_lowercase();
    if matches!(error.kind(), serialport::ErrorKind::NoDevice)
        && ["busy", "locked", "exclusive", "ebusy"]
            .iter()
            .any(|word| detail.contains(word))
    {
        "Gerät wird bereits verwendet".into()
    } else {
        error_text(device, error.kind())
    }
}

fn open_port(config: &SerialConfig) -> Result<Box<dyn serialport::SerialPort>, String> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let port = config
            .builder()
            .open_native()
            .map_err(|e| open_error(&config.device, &e))?;
        // poll() alone cannot bound a blocking tty write after CTS/XOFF changes.
        // SAFETY: the descriptor belongs to the live port; fcntl does not retain it.
        let flags = unsafe { libc::fcntl(port.as_raw_fd(), libc::F_GETFL) };
        if flags < 0
            || unsafe { libc::fcntl(port.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
        {
            return Err(error_text(
                &config.device,
                serialport::ErrorKind::Io(std::io::Error::last_os_error().kind()),
            ));
        }
        Ok(Box::new(port))
    }
    #[cfg(not(unix))]
    config
        .builder()
        .open()
        .map_err(|e| open_error(&config.device, &e))
}
#[derive(Serialize)]
pub struct Port {
    name: String,
    description: String,
}
pub fn port_type(kind: &serialport::SerialPortType) -> String {
    match kind {
        serialport::SerialPortType::UsbPort(info) => format!(
            "USB {:04X}:{:04X} {} {}",
            info.vid,
            info.pid,
            info.manufacturer.as_deref().unwrap_or(""),
            info.product.as_deref().unwrap_or("")
        )
        .trim()
        .to_owned(),
        serialport::SerialPortType::PciPort => "PCI".into(),
        serialport::SerialPortType::BluetoothPort => "Bluetooth".into(),
        serialport::SerialPortType::Unknown => "Unbekannt".into(),
    }
}
#[tauri::command]
pub async fn serial_ports() -> Result<Vec<Port>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "linux")]
        if !std::path::Path::new("/sys/class/tty").is_dir() {
            return Ok(vec![]);
        }
        let ports = std::panic::catch_unwind(serialport::available_ports)
            .map_err(|_| "Serielle Ports konnten nicht ermittelt werden".to_owned())?
            .map_err(|e| e.to_string())?;
        let mut ports: Vec<_> = ports
            .into_iter()
            .map(|p| Port {
                name: p.port_name,
                description: port_type(&p.port_type),
            })
            .collect();
        #[cfg(target_os = "linux")]
        if let Ok(entries) = std::fs::read_dir("/dev/serial/by-id") {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Ok(target) = std::fs::canonicalize(&path) {
                    ports.push(Port {
                        name: path.to_string_lossy().into_owned(),
                        description: target.to_string_lossy().into_owned(),
                    });
                }
            }
        }
        ports.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(ports)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn serial_connect(
    app: tauri::AppHandle,
    config: SerialConfig,
    tab_id: u32,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<Option<u32>>,
) -> Result<u32, String> {
    config.validate()?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut reader = open_port(&config)?;
        let mut writer = reader
            .try_clone()
            .map_err(|e| error_text(&config.device, e.kind()))?;
        let (tx, mut rx) = tokio::sync::mpsc::channel(128);
        let (id, control) = crate::telnet::register(tx);
        let output = Arc::new(Output {
            app,
            tab: tab_id,
            data: on_data,
            exit: on_exit,
        });
        let stop = control.stop.clone();
        let read_stop = stop.clone();
        let read_output = output.clone();
        let device = config.device.clone();
        let read_thread = std::thread::spawn(move || {
            let mut buffer = [0; 8192];
            while !read_stop.load(Ordering::Acquire) {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        read_output.error(format!("Gerät {device} entfernt"));
                        break;
                    }
                    Ok(n) => read_output.data(buffer[..n].to_vec()),
                    Err(e)
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::TimedOut
                                | std::io::ErrorKind::Interrupted
                                | std::io::ErrorKind::WouldBlock
                        ) => {}
                    Err(e) => {
                        read_output.error(error_text(&device, serialport::ErrorKind::Io(e.kind())));
                        break;
                    }
                }
            }
            read_stop.store(true, Ordering::Release);
        });
        std::thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                match rx.try_recv() {
                    Ok(Message::Data(bytes)) => {
                        let bytes = input(&bytes, &config.enter);
                        match write_interruptible(&mut writer, &bytes, &stop) {
                            Ok(true) => (),
                            Ok(false) => break,
                            Err(e) => {
                                output.error(error_text(
                                    &config.device,
                                    serialport::ErrorKind::Io(e.kind()),
                                ));
                                break;
                            }
                        }
                        let local = echo(&bytes, config.local_echo);
                        if !local.is_empty() {
                            output.data(local);
                        }
                    }
                    Ok(Message::Break) => {
                        let result = writer.set_break().and_then(|()| {
                            std::thread::sleep(Duration::from_millis(300));
                            writer.clear_break()
                        });
                        if let Err(e) = result {
                            output.error(error_text(&config.device, e.kind()));
                        }
                    }
                    Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => break,
                    Ok(Message::Resize(_, _)) => (),
                    Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                }
            }
            stop.store(true, Ordering::Release);
            // Discard driver-buffered output as well as the pending channel data.
            drop(rx);
            let _ = writer.clear(serialport::ClearBuffer::Output);
            let _ = read_thread.join();
            drop(writer);
            crate::telnet::remove(id);
            output.finish();
        });
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timed_out_writer_stops_and_releases_handle() {
        use std::sync::atomic::AtomicBool;
        struct TimeoutWriter {
            attempted: std::sync::mpsc::Sender<()>,
            dropped: Arc<AtomicBool>,
        }
        impl Write for TimeoutWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                assert!(bytes.len() <= 256);
                let _ = self.attempted.send(());
                std::thread::sleep(Duration::from_millis(100));
                Err(std::io::ErrorKind::TimedOut.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                panic!("must not drain on close")
            }
        }
        impl Drop for TimeoutWriter {
            fn drop(&mut self) {
                self.dropped.store(true, Ordering::Release);
            }
        }
        let stop = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicBool::new(false));
        let (attempted, attempts) = std::sync::mpsc::channel();
        let (done, finished) = std::sync::mpsc::channel();
        let thread_stop = stop.clone();
        let mut writer = TimeoutWriter {
            attempted,
            dropped: dropped.clone(),
        };
        let thread = std::thread::spawn(move || {
            let result = write_interruptible(&mut writer, &[0; 4096], &thread_stop);
            drop(writer);
            done.send(result).unwrap();
        });
        attempts.recv_timeout(Duration::from_secs(1)).unwrap();
        stop.store(true, Ordering::Release);
        assert!(
            !finished
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .unwrap()
        );
        thread.join().unwrap();
        assert!(dropped.load(Ordering::Acquire));
    }

    #[test]
    fn partial_writes_retry_without_losing_bytes() {
        struct PartialWriter {
            bytes: Vec<u8>,
            retry: bool,
        }
        impl Write for PartialWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                assert!(bytes.len() <= 256);
                self.retry = !self.retry;
                if self.retry {
                    return Err(std::io::ErrorKind::WouldBlock.into());
                }
                let count = bytes.len().min(17);
                self.bytes.extend_from_slice(&bytes[..count]);
                Ok(count)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut writer = PartialWriter {
            bytes: vec![],
            retry: false,
        };
        let bytes: Vec<_> = (0..=255).cycle().take(1024).collect();
        assert!(write_interruptible(&mut writer, &bytes, &Default::default()).unwrap());
        assert_eq!(writer.bytes, bytes);
    }
    #[test]
    fn validation_and_mapping() {
        let mut c = SerialConfig {
            device: "COM3".into(),
            ..Default::default()
        };
        assert!(c.validate().is_ok());
        assert_eq!(c.baud, 115200);
        for bits in 5..=8 {
            c.data_bits = bits;
            assert!(c.validate().is_ok());
            assert_eq!(u8::from(c.parameters().0), bits);
        }
        c.data_bits = 9;
        assert!(c.validate().is_err());
        c.data_bits = 8;
        for field in ["parity", "flow", "enter"] {
            let mut value = serde_json::to_value(&c).unwrap();
            value[field] = serde_json::json!("invalid");
            assert!(
                serde_json::from_value::<SerialConfig>(value)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
    }
    #[test]
    fn enter_and_echo() {
        for (mode, expected) in [
            ("cr", b"a\r".as_slice()),
            ("lf", b"a\n".as_slice()),
            ("crlf", b"a\r\n".as_slice()),
        ] {
            assert_eq!(input(b"a\r", mode), expected);
        }
        assert_eq!(echo(b"abc", true), b"abc");
        assert!(echo(b"abc", false).is_empty());
    }
    #[test]
    fn descriptions_and_errors() {
        assert_eq!(port_type(&serialport::SerialPortType::PciPort), "PCI");
        assert_eq!(
            port_type(&serialport::SerialPortType::BluetoothPort),
            "Bluetooth"
        );
        assert_eq!(port_type(&serialport::SerialPortType::Unknown), "Unbekannt");
        assert_eq!(
            error_text(
                "x",
                serialport::ErrorKind::Io(std::io::ErrorKind::ResourceBusy)
            ),
            "Gerät wird bereits verwendet"
        );
        assert!(error_text("x", serialport::ErrorKind::NoDevice).contains("entfernt"));
        assert!(
            error_text(
                "x",
                serialport::ErrorKind::Io(std::io::ErrorKind::PermissionDenied)
            )
            .contains("Berechtigung")
        );
    }
    #[test]
    fn usb_description_and_busy_error_preserve_context() {
        let usb = serialport::SerialPortType::UsbPort(serialport::UsbPortInfo {
            vid: 0x0403,
            pid: 0x6001,
            serial_number: Some("test".into()),
            manufacturer: Some("FTDI".into()),
            product: Some("USB UART".into()),
        });
        assert_eq!(port_type(&usb), "USB 0403:6001 FTDI USB UART");
        assert_eq!(
            open_error(
                "/dev/ttyUSB0",
                &serialport::Error::new(
                    serialport::ErrorKind::NoDevice,
                    "EBUSY: Device or resource busy"
                )
            ),
            "Gerät wird bereits verwendet"
        );
        assert!(
            open_error(
                "COM3",
                &serialport::Error::new(serialport::ErrorKind::NoDevice, "not found")
            )
            .contains("entfernt")
        );
    }
    #[test]
    fn mapping_preserves_parity_flow_and_stop_bits() {
        let mut config = SerialConfig {
            device: "COM3".into(),
            ..Default::default()
        };
        for (value, expected) in [
            ("none", serialport::Parity::None),
            ("odd", serialport::Parity::Odd),
            ("even", serialport::Parity::Even),
        ] {
            config.parity = value.into();
            assert!(config.validate().is_ok());
            assert_eq!(config.parameters().1, expected);
        }
        for (value, expected) in [
            ("none", serialport::FlowControl::None),
            ("software", serialport::FlowControl::Software),
            ("hardware", serialport::FlowControl::Hardware),
        ] {
            config.flow = value.into();
            assert!(config.validate().is_ok());
            assert_eq!(config.parameters().3, expected);
        }
        for bits in [1, 2] {
            config.stop_bits = bits;
            assert_eq!(u8::from(config.parameters().2), bits);
        }
        config.baud = 0;
        assert!(config.validate().is_err());
        config.baud = 115200;
        config.device = "bad\0device".into();
        assert!(config.validate().is_err());
    }
}
