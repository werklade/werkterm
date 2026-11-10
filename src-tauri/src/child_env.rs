//! Keeps Werkterm's own start-up environment tweaks out of child processes.
//!
//! On Linux `linux_graphics::apply` may set WebKit/NVIDIA variables for our WebView.
//! Shells, tools and other programs started by Werkterm must see the user's original
//! environment, so every spawn site calls [`strip_inherited`]. On other platforms
//! nothing is recorded and the call is a no-op.

use std::sync::OnceLock;

static SET_BY_WERKTERM: OnceLock<Vec<&'static str>> = OnceLock::new();

/// Something that can drop a variable from a child's environment.
pub trait EnvRemove {
    fn remove_env(&mut self, key: &str);
}

impl EnvRemove for std::process::Command {
    fn remove_env(&mut self, key: &str) {
        self.env_remove(key);
    }
}

impl EnvRemove for portable_pty::CommandBuilder {
    fn remove_env(&mut self, key: &str) {
        self.env_remove(key);
    }
}

/// Records the variables Werkterm set itself (first call wins).
#[cfg(target_os = "linux")]
pub fn record(keys: Vec<&'static str>) {
    let _ = SET_BY_WERKTERM.set(keys);
}

fn recorded() -> &'static [&'static str] {
    SET_BY_WERKTERM.get().map(Vec::as_slice).unwrap_or(&[])
}

fn strip_keys<C: EnvRemove>(command: &mut C, keys: &[&str]) {
    for key in keys {
        command.remove_env(key);
    }
}

/// Removes every variable Werkterm set at start-up from `command`'s environment.
pub fn strip_inherited<C: EnvRemove>(command: &mut C) {
    strip_keys(command, recorded());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Fake(Vec<String>);

    impl EnvRemove for Fake {
        fn remove_env(&mut self, key: &str) {
            self.0.push(key.to_owned());
        }
    }

    #[test]
    fn strips_given_keys() {
        let mut fake = Fake::default();
        strip_keys(&mut fake, &["A", "B"]);
        assert_eq!(fake.0, ["A", "B"]);
    }

    #[test]
    fn nothing_recorded_means_no_op() {
        // Tests never call `record`, so the global list stays empty.
        let mut fake = Fake::default();
        strip_inherited(&mut fake);
        assert!(fake.0.is_empty());
    }

    #[test]
    fn removes_from_real_command() {
        let mut command = std::process::Command::new("x");
        command.env("WERKTERM_CHILD_ENV_TEST", "1");
        strip_keys(&mut command, &["WERKTERM_CHILD_ENV_TEST"]);
        let entry = command
            .get_envs()
            .find(|(key, _)| *key == "WERKTERM_CHILD_ENV_TEST");
        assert_eq!(entry, Some(("WERKTERM_CHILD_ENV_TEST".as_ref(), None)));
    }
}
