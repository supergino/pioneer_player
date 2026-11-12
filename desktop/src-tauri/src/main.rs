//! Wrapper desktop (Tauri) del controller Pioneer HM86D.
//!
//! All'avvio l'app:
//!   1. sceglie una porta locale libera;
//!   2. avvia il server Express incluso nel bundle (server.js + runtime Node.js);
//!   3. aspetta che la porta risponda;
//!   4. apre una finestra nativa che punta all'interfaccia web.
//!
//! Alla chiusura l'app termina il processo Node, così non restano server orfani.

use std::fs::File;
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// Processo Node del server, tenuto vivo finché l'app resta aperta.
struct ServerProcess(Mutex<Option<Child>>);

impl ServerProcess {
    fn kill(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Chiede al sistema una porta TCP libera su loopback.
fn pick_free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(3000)
}

/// Attende che il server cominci ad accettare connessioni sulla porta.
fn wait_for_server(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().expect("indirizzo loopback"),
            Duration::from_millis(200),
        )
        .is_ok()
        {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn spawn_server(res_dir: &Path, log_dir: &Path, port: u16) -> std::io::Result<Child> {
    let node = res_dir.join("node");
    let server = res_dir.join("server.js");

    let mut cmd = Command::new(&node);
    cmd.current_dir(res_dir)
        .arg(&server)
        .env("HTTP_PORT", port.to_string())
        .env("HTTP_BIND", "127.0.0.1")
        .env("DEVICE_HOST", std::env::var("PIONEER_DEVICE_HOST").unwrap_or_else(|_| "192.168.100.6".into()))
        .env("DEVICE_PORT", std::env::var("PIONEER_DEVICE_PORT").unwrap_or_else(|_| "60128".into()))
        .env("DEVICE_MAC", std::env::var("PIONEER_DEVICE_MAC").unwrap_or_else(|_| "00:09:B0:1F:A9:DF".into()))
        .env("DEVICE_BROADCAST", std::env::var("PIONEER_DEVICE_BROADCAST").unwrap_or_default())
        .stdin(Stdio::null());

    match File::create(log_dir.join("server.log")) {
        Ok(out) => {
            let err = out.try_clone()?;
            cmd.stdout(Stdio::from(out)).stderr(Stdio::from(err));
        }
        Err(_) => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }

    cmd.spawn()
}

fn main() {
    let app = tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            let res_dir = app.path().resource_dir()?.join("resources");
            let log_dir = app
                .path()
                .app_log_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("pioneer-controller"));
            let _ = std::fs::create_dir_all(&log_dir);

            let port = pick_free_port();
            let child = spawn_server(&res_dir, &log_dir, port)?;
            if let Some(state) = app.try_state::<ServerProcess>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = Some(child);
                }
            }

            let ready = wait_for_server(port, Duration::from_secs(25));
            if !ready {
                eprintln!(
                    "Server non raggiungibile sulla porta {port}. Log: {}",
                    log_dir.join("server.log").display()
                );
            }

            let url = format!("http://127.0.0.1:{port}")
                .parse()
                .expect("URL locale valido");

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Pioneer HM86D")
                .inner_size(1360.0, 900.0)
                .min_inner_size(960.0, 640.0)
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("errore nella creazione dell'app Tauri");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(state) = app_handle.try_state::<ServerProcess>() {
                state.kill();
            }
        }
    });
}
