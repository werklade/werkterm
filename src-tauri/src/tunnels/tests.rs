use super::*;
fn sample() -> Tunnel {
    Tunnel {
        id: "one".into(),
        name: "Database".into(),
        kind: Kind::Local,
        session_id: "ssh".into(),
        bind_address: default_bind(),
        bind_port: 8080,
        target_host: "db.internal".into(),
        target_port: Some(5432),
        autostart: false,
        reconnect: false,
        allow_public: false,
    }
}
#[test]
fn storage_roundtrip_corruption_version() {
    let directory =
        std::env::temp_dir().join(format!("werkterm-tunnels-{}", crate::sessions::new_id()));
    let path = directory.join("tunnels.json");
    assert!(load(&path).unwrap().is_empty());
    write_atomic(&path, vec![sample()]).unwrap();
    let list = load(&path).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "Database");
    write_atomic(&path, vec![]).unwrap();
    assert!(load(&path).unwrap().is_empty());
    assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
    for contents in [
        b"broken".as_slice(),
        br#"{"version":2,"tunnels":[]}"#,
        br#"{"version":1,"tunnels":[{}]}"#,
    ] {
        std::fs::write(&path, contents).unwrap();
        assert!(load(&path).is_err());
        assert!(write_atomic(&path, vec![]).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), contents);
    }
    std::fs::remove_dir_all(directory).unwrap();
}
#[test]
fn validation_and_loopback() {
    let mut t = sample();
    assert!(validate_fields(&t).is_ok());
    for host in [
        "127.0.0.1",
        "127.1.2.3",
        "127.255.255.255",
        "::1",
        "0:0:0:0:0:0:0:1",
        "localhost",
        "LOCALHOST",
    ] {
        assert!(is_loopback(host), "{host}");
    }
    for host in [
        "0.0.0.0",
        "::",
        "192.168.1.2",
        "localhost.evil",
        "127.0.0.1.example",
        "127.256.0.1",
    ] {
        assert!(!is_loopback(host), "{host}");
    }
    for host in ["", "bad host", "bad\thost", "bad\0host", "bad\nhost"] {
        t.target_host = host.into();
        assert!(validate_fields(&t).is_err());
    }
    t = sample();
    t.bind_port = 0;
    assert!(validate_fields(&t).is_err());
    t.kind = Kind::Remote;
    assert!(validate_fields(&t).is_ok());
    t.target_port = Some(0);
    assert!(validate_fields(&t).is_err());
    t.target_port = None;
    assert!(validate_fields(&t).is_err());
    t.kind = Kind::Dynamic;
    t.bind_port = 1080;
    t.target_host.clear();
    assert!(validate_fields(&t).is_ok());
    t = sample();
    assert!(validate(&t, &[]).is_err());
    let mut s:crate::sessions::SavedSession=serde_json::from_value(serde_json::json!({"id":"ssh","name":"SSH","kind":"ssh","folder":"","host":"host","port":22,"user":null,"auth":{"type":"default"},"source":null})).unwrap();
    assert!(validate(&t, std::slice::from_ref(&s)).is_ok());
    s.kind = "local".into();
    assert!(validate(&t, &[s]).is_err());
    let mut value = serde_json::to_value(&t).unwrap();
    value["bind_port"] = serde_json::json!(65536);
    assert!(serde_json::from_value::<Tunnel>(value).is_err());
}
#[test]
fn session_delete_protection() {
    assert!(protect("other", &[sample()]).is_ok());
    assert!(
        protect("ssh", &[sample()])
            .unwrap_err()
            .contains("Database")
    );
}
#[test]
fn socks_greetings() {
    assert_eq!(greeting(&[5, 1, 0]), Ok(Some(3)));
    assert_eq!(greeting(&[5, 2, 2, 0]), Ok(Some(4)));
    assert_eq!(greeting(&[5, 1, 2]), Err(255));
    assert_eq!(greeting(&[4, 1, 0]), Err(255));
    assert_eq!(greeting(&[5, 0]), Err(255));
    for b in [&[][..], &[5][..], &[5, 2, 0][..]] {
        assert_eq!(greeting(b), Ok(None));
    }
}
#[test]
fn socks_connect_and_errors() {
    let ipv4 = [5, 1, 0, 1, 127, 0, 0, 1, 0, 80];
    assert_eq!(request(&ipv4), Ok(Some(("127.0.0.1".into(), 80))));
    for n in 0..ipv4.len() {
        assert_eq!(request(&ipv4[..n]), Ok(None));
    }
    let mut ipv6 = vec![5, 1, 0, 4];
    ipv6.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 187]);
    assert_eq!(request(&ipv6), Ok(Some(("::1".into(), 443))));
    for n in 0..ipv6.len() {
        assert_eq!(request(&ipv6[..n]), Ok(None));
    }
    let domain = b"\x05\x01\x00\x03\x0bexample.org\x01\xbb";
    assert_eq!(request(domain), Ok(Some(("example.org".into(), 443))));
    for n in 0..domain.len() {
        assert_eq!(request(&domain[..n]), Ok(None));
    }
    for command in [2, 3] {
        assert_eq!(request(&[5, command, 0, 1]), Err(7));
    }
    assert_eq!(request(&[5, 1, 0, 9]), Err(8));
    assert_eq!(request(&[5, 1, 0, 3, 0]), Err(8));
    assert_eq!(request(&[5, 1, 1, 1]), Err(1));
    assert_eq!(request(b"\x05\x01\x00\x03\x01\xff\x00\x50"), Err(8));
}
#[test]
fn forwarding_route_and_backoff() {
    let mut t = sample();
    t.kind = Kind::Remote;
    assert!(matches_forward(&t, 9090, "127.0.0.1", 9090));
    assert!(!matches_forward(&t, 9090, "0.0.0.0", 9090));
    assert!(!matches_forward(&t, 9090, "127.0.0.1", 8080));
    t.kind = Kind::Local;
    assert!(!matches_forward(&t, 9090, "127.0.0.1", 9090));
    assert_eq!(
        (0..7).map(|n| backoff(n).as_secs()).collect::<Vec<_>>(),
        [5, 10, 30, 60, 60, 60, 60]
    );
}
#[tokio::test]
async fn local_bidirectional_copy_and_counters() {
    let (mut client, local) = tokio::io::duplex(64);
    let (remote, mut server) = tokio::io::duplex(64);
    let counters = Arc::new(Counters::default());
    let task = tokio::spawn(copy(local, remote, counters.clone()));
    client.write_all(b"request").await.unwrap();
    let mut buf = [0; 7];
    server.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"request");
    server.write_all(b"reply").await.unwrap();
    let mut buf = [0; 5];
    client.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"reply");
    client.shutdown().await.unwrap();
    server.shutdown().await.unwrap();
    task.await.unwrap();
    assert_eq!(counters.outgoing.load(Ordering::Relaxed), 7);
    assert_eq!(counters.incoming.load(Ordering::Relaxed), 5);
    assert_eq!(counters.active.load(Ordering::Relaxed), 0);
}

struct RejectPrompter {
    calls: Arc<AtomicU64>,
}
impl crate::ssh::Prompter for RejectPrompter {
    fn confirm_host_key(
        &self,
        _: String,
        _: u16,
        _: String,
        _: String,
    ) -> crate::ssh::PromptFuture<bool> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Box::pin(async { false })
    }
    fn ask_secret(
        &self,
        _: crate::ssh::SecretKind,
        _: String,
    ) -> crate::ssh::PromptFuture<Option<String>> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Box::pin(async { None })
    }
}
#[tokio::test]
async fn canceled_prompt_prevents_further_prompts() {
    use crate::ssh::Prompter;
    let rejected = Arc::new(AtomicBool::new(false));
    let calls = Arc::new(AtomicU64::new(0));
    let prompter = CancelAwarePrompter {
        inner: Arc::new(RejectPrompter {
            calls: calls.clone(),
        }),
        rejected: rejected.clone(),
    };
    assert!(
        !prompter
            .confirm_host_key("host".into(), 22, "key".into(), "fingerprint".into())
            .await
    );
    assert!(rejected.load(Ordering::Relaxed));
    assert!(
        prompter
            .ask_secret(crate::ssh::SecretKind::Password, "password".into())
            .await
            .is_none()
    );
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[test]
fn socks_channel_errors_are_protocol_codes() {
    assert_eq!(
        socks_channel_error(&russh::Error::ChannelOpenFailure(
            russh::ChannelOpenFailure::ConnectFailed
        )),
        5
    );
    assert_eq!(socks_channel_error(&russh::Error::Disconnect), 4);
}

#[tokio::test]
async fn connection_limit_counts_setup_and_releases_on_abort() {
    let counters = Arc::new(Counters::default());
    let connections = Connections::new(2, counters.clone());
    let first = connections.try_acquire().unwrap();
    let second = connections.try_acquire().unwrap();
    assert!(connections.try_acquire().is_none());
    assert_eq!(counters.active.load(Ordering::Relaxed), 2);
    drop(first);
    let replacement = connections.try_acquire().unwrap();
    let task = tokio::spawn(async move {
        let _active = second;
        std::future::pending::<()>().await;
    });
    task.abort();
    let _ = task.await;
    assert_eq!(counters.active.load(Ordering::Relaxed), 1);
    assert!(connections.try_acquire().is_some());
    drop(replacement);
    assert_eq!(counters.active.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn late_or_unread_open_confirmation_closes_owned_resource() {
    struct CloseOnDrop(Arc<AtomicBool>);
    impl Drop for CloseOnDrop {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
        }
    }
    for abandon_before_send in [true, false] {
        let closed = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = oneshot::channel::<Result<CloseOnDrop, ()>>();
        if abandon_before_send {
            // Same ownership state as timeout/cancellation before confirmation.
            drop(receiver);
            deliver_opened(sender, Ok(CloseOnDrop(closed.clone())));
        } else {
            deliver_opened(sender, Ok(CloseOnDrop(closed.clone())));
            assert!(!closed.load(Ordering::Relaxed));
            drop(receiver);
        }
        assert!(closed.load(Ordering::Relaxed));
    }
}
#[test]
fn autostart_reports_every_failed_tunnel_with_its_name() {
    assert_eq!(autostart_result(Vec::new()), Ok(()));
    let error = autostart_result(vec![
        (
            "Database".into(),
            ui_err("TUNNEL_PORT_IN_USE").arg("port", "8080").into(),
        ),
        ("Web".into(), ui_err("TUNNEL_DISCONNECTED").into()),
    ])
    .unwrap_err();
    let (code, payload) = error.split_once(": ").unwrap();
    assert_eq!(code, "TUNNEL_AUTOSTART_FAILED");
    let payload: serde_json::Value = serde_json::from_str(payload).unwrap();
    assert_eq!(payload["args"]["count"], "2");
    let errors: Vec<String> =
        serde_json::from_str(payload["args"]["errors"].as_str().unwrap()).unwrap();
    assert_eq!(
        errors,
        [
            r#"TUNNEL_START_FAILED: {"args":{"error":"TUNNEL_PORT_IN_USE: {\"args\":{\"port\":\"8080\"}}","name":"Database"}}"#,
            r#"TUNNEL_START_FAILED: {"args":{"error":"TUNNEL_DISCONNECTED","name":"Web"}}"#,
        ]
    );
}
