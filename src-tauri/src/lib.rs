use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
// Manager liefert auch app.path() für den Recovery-Pfad
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

// Max. Frame-Größe als Schutz gegen kaputte Längenprefixe
const MAX_FRAME: usize = 16 * 1024 * 1024;

struct NetState {
    outgoing: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
}

fn emit_status(app: &AppHandle, status: &str) {
    let _ = app.emit("net-status", status);
}

/// LAN-IP über Routing-Lookup ermitteln (UDP-connect sendet keine Pakete)
fn local_ip() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:80").ok()?;
    Some(s.local_addr().ok()?.ip().to_string())
}

/// Verbundenen Stream an Lese-/Schreib-Tasks hängen (Framing: u32-BE-Länge + Payload)
fn attach_stream(app: &AppHandle, stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    let (mut reader, mut writer) = stream.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    {
        let st = app.state::<NetState>();
        *st.outgoing.lock().unwrap() = Some(tx);
    }
    emit_status(app, "connected");

    let write_task = tauri::async_runtime::spawn(async move {
        while let Some(data) = rx.recv().await {
            let len = (data.len() as u32).to_be_bytes();
            if writer.write_all(&len).await.is_err() || writer.write_all(&data).await.is_err() {
                break;
            }
        }
    });

    let app_r = app.clone();
    let read_task = tauri::async_runtime::spawn(async move {
        loop {
            let mut lenbuf = [0u8; 4];
            if reader.read_exact(&mut lenbuf).await.is_err() {
                break;
            }
            let len = u32::from_be_bytes(lenbuf) as usize;
            if len > MAX_FRAME {
                break;
            }
            let mut buf = vec![0u8; len];
            if reader.read_exact(&mut buf).await.is_err() {
                break;
            }
            let _ = app_r.emit("net-recv", buf);
        }
        let st = app_r.state::<NetState>();
        *st.outgoing.lock().unwrap() = None;
        emit_status(&app_r, "disconnected");
    });

    let st = app.state::<NetState>();
    let mut tasks = st.tasks.lock().unwrap();
    tasks.push(write_task);
    tasks.push(read_task);
}

fn leave_inner(app: &AppHandle) {
    let st = app.state::<NetState>();
    *st.outgoing.lock().unwrap() = None;
    for h in st.tasks.lock().unwrap().drain(..) {
        h.abort();
    }
}

#[tauri::command]
async fn host_session(app: AppHandle, port: u16) -> Result<String, String> {
    leave_inner(&app);
    // Kurzer Retry: der Task-Abort aus leave_inner gibt den Port asynchron frei —
    // direktes Re-Hosting auf demselben Port darf daran nicht scheitern.
    let listener = {
        let mut attempt = 0;
        loop {
            match TcpListener::bind(("0.0.0.0", port)).await {
                Ok(l) => break l,
                Err(_) if attempt < 10 => {
                    attempt += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                Err(e) => return Err(format!("Port {port}: {e}")),
            }
        }
    };
    let ip = local_ip().unwrap_or_else(|| "127.0.0.1".into());
    emit_status(&app, "listening");

    let app2 = app.clone();
    let accept_task = tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let busy = app2.state::<NetState>().outgoing.lock().unwrap().is_some();
                    if busy {
                        // v0: genau ein Peer — weitere Verbindungen abweisen
                        drop(stream);
                        continue;
                    }
                    attach_stream(&app2, stream);
                }
                Err(_) => break,
            }
        }
    });
    app.state::<NetState>().tasks.lock().unwrap().push(accept_task);
    Ok(format!("{ip}:{port}"))
}

#[tauri::command]
async fn join_session(app: AppHandle, addr: String) -> Result<(), String> {
    leave_inner(&app);
    let stream = TcpStream::connect(&addr)
        .await
        .map_err(|e| format!("{addr}: {e}"))?;
    attach_stream(&app, stream);
    Ok(())
}

#[tauri::command]
fn net_send(state: State<NetState>, data: Vec<u8>) -> Result<(), String> {
    match state.outgoing.lock().unwrap().as_ref() {
        Some(tx) => tx.send(data).map_err(|e| e.to_string()),
        None => Err("nicht verbunden".into()),
    }
}

#[tauri::command]
fn leave_session(app: AppHandle) {
    leave_inner(&app);
    emit_status(&app, "offline");
}

#[tauri::command]
fn recovery_file_path(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("recovery.md").to_string_lossy().into_owned())
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(NetState {
            outgoing: Mutex::new(None),
            tasks: Mutex::new(Vec::new()),
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            recovery_file_path,
            host_session,
            join_session,
            net_send,
            leave_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
