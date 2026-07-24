use std::sync::{Arc, Mutex};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use bytes::Bytes;
use tauri::{AppHandle, Emitter, Manager, State};
use webrtc::api::APIBuilder;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
// Manager liefert auch app.path() für den Recovery-Pfad
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

// Max. Frame-Größe als Schutz gegen kaputte Längenprefixe
const MAX_FRAME: usize = 16 * 1024 * 1024;

struct NetState {
    outgoing: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
    // aktive WebRTC-PeerConnection (Internet-Session via Code-Tausch)
    pc: Mutex<Option<Arc<RTCPeerConnection>>>,
    // mDNS: ein Daemon pro App; registrierter Service-Name beim Hosten
    mdns: Mutex<Option<mdns_sd::ServiceDaemon>>,
    mdns_fullname: Mutex<Option<String>>,
    // Zählt jede Session-Auflösung. WebRTC-Callbacks laufen in der Maschinerie
    // von webrtc-rs und überleben `leave_inner` — sie müssen prüfen können, ob
    // sie noch zur aktuellen Session gehören.
    epoch: std::sync::atomic::AtomicU64,
}

/// Gehört dieser Callback noch zur laufenden Session? Ohne diese Prüfung
/// überschreibt eine alte, noch nicht geschlossene Verbindung den Sendekanal
/// der neuen — Dokumentinhalt ginge dann an den falschen Peer.
fn is_current(app: &AppHandle, epoch: u64) -> bool {
    app.state::<NetState>()
        .epoch
        .load(std::sync::atomic::Ordering::SeqCst)
        == epoch
}

fn current_epoch(app: &AppHandle) -> u64 {
    app.state::<NetState>()
        .epoch
        .load(std::sync::atomic::Ordering::SeqCst)
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
    // Alles, was ab jetzt aus der alten Session zurückruft, ist überholt
    st.epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    *st.outgoing.lock().unwrap() = None;
    for h in st.tasks.lock().unwrap().drain(..) {
        h.abort();
    }
    let taken = st.pc.lock().unwrap().take();
    if let Some(pc) = taken {
        tauri::async_runtime::spawn(async move {
            let _ = pc.close().await;
        });
    }
    // mDNS-Ansage zurückziehen (Daemon selbst bleibt für Browse bestehen)
    let fullname = st.mdns_fullname.lock().unwrap().take();
    if let Some(name) = fullname {
        let guard = st.mdns.lock().unwrap();
        if let Some(daemon) = guard.as_ref() {
            let _ = daemon.unregister(&name);
        }
    }
}

// ---------- mDNS: LAN-Discovery (Host taucht in der Gast-Liste auf) ----------

const MDNS_SERVICE: &str = "_quodliber._tcp.local.";

#[derive(serde::Serialize, Clone)]
struct LanHost {
    fullname: String,
    label: String,
    addr: String,
    id: String,
}

/// Werte aus fremden mDNS-Ansagen sind unvalidierte Netzwerk-Eingaben (jedes
/// Gerät im LAN darf sie setzen): Steuerzeichen raus, auf Anzeigelänge kürzen.
fn clean_prop(raw: &str, max: usize) -> String {
    raw.chars().filter(|c| !c.is_control()).take(max).collect()
}

/// Einmal beim App-Start: mDNS-Daemon anlegen und dauerhaft nach Quodliber-
/// Hosts im LAN browsen; Funde/Abgänge gehen als Events ans Frontend.
#[tauri::command]
fn lan_init(app: AppHandle) -> Result<(), String> {
    let st = app.state::<NetState>();
    let mut guard = st.mdns.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }
    let daemon = mdns_sd::ServiceDaemon::new().map_err(|e| e.to_string())?;
    let receiver = daemon.browse(MDNS_SERVICE).map_err(|e| e.to_string())?;
    *guard = Some(daemon);
    drop(guard);

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        // Obergrenze, damit ein einzelnes Gerät die Beitritts-Liste des
        // Nutzers nicht mit hunderten Ansagen fluten kann
        const MAX_HOSTS: usize = 32;
        let mut announced: std::collections::HashSet<String> = std::collections::HashSet::new();
        while let Ok(event) = receiver.recv_async().await {
            match event {
                mdns_sd::ServiceEvent::ServiceResolved(info) => {
                    let fullname = info.get_fullname().to_string();
                    if !announced.contains(&fullname) && announced.len() >= MAX_HOSTS {
                        continue;
                    }
                    let addr = info
                        .get_addresses()
                        .iter()
                        .find(|a| a.is_ipv4())
                        .or_else(|| info.get_addresses().iter().next())
                        .map(|a| format!("{}:{}", a, info.get_port()));
                    if let Some(addr) = addr {
                        let label = clean_prop(info.get_property_val_str("name").unwrap_or(""), 40);
                        let host = LanHost {
                            fullname: fullname.clone(),
                            label: if label.trim().is_empty() {
                                "Unbekannt".to_string()
                            } else {
                                label
                            },
                            addr,
                            id: clean_prop(info.get_property_val_str("id").unwrap_or(""), 64),
                        };
                        announced.insert(fullname);
                        let _ = app2.emit("lan-found", host);
                    }
                }
                mdns_sd::ServiceEvent::ServiceRemoved(_ty, fullname) => {
                    announced.remove(&fullname);
                    let _ = app2.emit("lan-removed", fullname);
                }
                _ => {}
            }
        }
    });
    Ok(())
}

/// Beim Hosten: eigenen Service im LAN ansagen (best effort — Scheitern der
/// Ansage verhindert die Session nicht, es fehlt dann nur der Listen-Eintrag).
fn mdns_announce(app: &AppHandle, port: u16, name: &str, id: &str) {
    // Zeichenweise kürzen: Byte-Slicing (`&id[..8]`) panickt an Nicht-ASCII-
    // Grenzen, und ein Panic unter dem Lock vergiftet den mDNS-Mutex dauerhaft
    let short_id: String = id.chars().take(8).collect();
    let instance = format!("{}-{}", name.replace('.', "_"), short_id);
    let st = app.state::<NetState>();
    let guard = st.mdns.lock().unwrap();
    let Some(daemon) = guard.as_ref() else { return };
    let props = [("name", name), ("id", id)];
    match mdns_sd::ServiceInfo::new(MDNS_SERVICE, &instance, &format!("{instance}.local."), "", port, &props[..])
        .map(|s| s.enable_addr_auto())
    {
        Ok(service) => {
            let fullname = service.get_fullname().to_string();
            if daemon.register(service).is_ok() {
                *st.mdns_fullname.lock().unwrap() = Some(fullname);
            }
        }
        Err(_) => {}
    }
}

// ---------- WebRTC (M3: Internet-Session via manuellem Code-Tausch) ----------

// Codes tragen ein Versions-Präfix, damit das Join-Feld sie von ip:port
// unterscheiden kann und künftige Formatwechsel erkennbar bleiben.
const CODE_PREFIX: &str = "QL1-";
// DataChannel-Nachrichten klein halten (SCTP-Limits); Frames werden gestückelt
// und über das u32-BE-Längenprefix wieder zusammengesetzt — gleiches Framing wie TCP.
const DC_CHUNK: usize = 16_000;

fn encode_desc(desc: &RTCSessionDescription) -> Result<String, String> {
    let json = serde_json::to_string(desc).map_err(|e| e.to_string())?;
    Ok(format!("{CODE_PREFIX}{}", B64.encode(json)))
}

fn decode_desc(code: &str) -> Result<RTCSessionDescription, String> {
    let raw = code
        .trim()
        .strip_prefix(CODE_PREFIX)
        .ok_or("Kein QL1-Code")?;
    let json = B64.decode(raw).map_err(|_| "Code beschädigt (Base64)")?;
    serde_json::from_slice(&json).map_err(|_| "Code beschädigt (Inhalt)".to_string())
}

async fn new_pc(app: &AppHandle) -> Result<Arc<RTCPeerConnection>, String> {
    let api = APIBuilder::new().build();
    let config = RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            // Mehrere STUN-Fallbacks; Google ist offiziell nur Dev-Nutzung —
            // für eine spätere kommerzielle Phase eigene Liste/coturn einplanen.
            urls: vec![
                "stun:stun.l.google.com:19302".to_string(),
                "stun:stun.cloudflare.com:3478".to_string(),
            ],
            ..Default::default()
        }],
        ..Default::default()
    };
    let pc = api
        .new_peer_connection(config)
        .await
        .map_err(|e| e.to_string())
        .map(Arc::new)?;

    // Verbindungsabbrüche nach dem Aufbau sichtbar machen + Zustände loggen
    let app2 = app.clone();
    pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
        let app3 = app2.clone();
        Box::pin(async move {
            let _ = app3.emit("net-log", format!("PeerConnection: {s}"));
            if matches!(
                s,
                RTCPeerConnectionState::Failed
                    | RTCPeerConnectionState::Disconnected
                    | RTCPeerConnectionState::Closed
            ) {
                let st = app3.state::<NetState>();
                *st.outgoing.lock().unwrap() = None;
                emit_status(&app3, "disconnected");
            }
        })
    }));
    let app_ice = app.clone();
    pc.on_ice_connection_state_change(Box::new(move |s| {
        let app3 = app_ice.clone();
        Box::pin(async move {
            let _ = app3.emit("net-log", format!("ICE: {s}"));
        })
    }));
    Ok(pc)
}

/// DataChannel an die bestehende Byte-Brücke hängen: gleiche net-recv/net-status-
/// Events und derselbe outgoing-Kanal wie beim TCP-Transport.
fn wire_datachannel(app: &AppHandle, dc: Arc<RTCDataChannel>, epoch: u64) {
    let recv_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));

    let app_open = app.clone();
    let dc_open = dc.clone();
    dc.on_open(Box::new(move || {
        let app2 = app_open.clone();
        let dc2 = dc_open.clone();
        Box::pin(async move {
            // Kanal einer bereits aufgelösten Session: nicht übernehmen
            if !is_current(&app2, epoch) {
                let _ = dc2.close().await;
                return;
            }
            let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
            *app2.state::<NetState>().outgoing.lock().unwrap() = Some(tx);
            emit_status(&app2, "connected");
            let h = tauri::async_runtime::spawn(async move {
                while let Some(data) = rx.recv().await {
                    let mut framed = Vec::with_capacity(4 + data.len());
                    framed.extend_from_slice(&(data.len() as u32).to_be_bytes());
                    framed.extend_from_slice(&data);
                    for chunk in framed.chunks(DC_CHUNK) {
                        if dc2.send(&Bytes::copy_from_slice(chunk)).await.is_err() {
                            return;
                        }
                    }
                }
            });
            app2.state::<NetState>().tasks.lock().unwrap().push(h);
        })
    }));

    let app_msg = app.clone();
    let dc_msg = dc.clone();
    dc.on_message(Box::new(move |msg| {
        let app2 = app_msg.clone();
        let dc2 = dc_msg.clone();
        let buf = recv_buf.clone();
        Box::pin(async move {
            if !is_current(&app2, epoch) {
                return;
            }
            let mut broken = false;
            let frames = {
                let mut b = buf.lock().unwrap();
                b.extend_from_slice(&msg.data);
                let mut out = Vec::new();
                loop {
                    if b.len() < 4 {
                        break;
                    }
                    let len = u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize;
                    if len > MAX_FRAME {
                        b.clear();
                        broken = true;
                        break;
                    }
                    if b.len() < 4 + len {
                        break;
                    }
                    out.push(b[4..4 + len].to_vec());
                    b.drain(..4 + len);
                }
                out
            };
            for f in frames {
                let _ = app2.emit("net-recv", f);
            }
            if broken {
                // Nach einem unmöglichen Längenprefix lässt sich der Strom nicht
                // mehr resynchronisieren — Kanal beenden statt dauerhaft Müll zu
                // parsen (der TCP-Pfad bricht an derselben Stelle die Verbindung ab)
                let _ = app2.emit("net-log", "Ungültige Frame-Länge — Kanal beendet");
                *app2.state::<NetState>().outgoing.lock().unwrap() = None;
                emit_status(&app2, "disconnected");
                let _ = dc2.close().await;
            }
        })
    }));

    let app_close = app.clone();
    dc.on_close(Box::new(move || {
        let app2 = app_close.clone();
        Box::pin(async move {
            // Ein alter Kanal darf die laufende Session nicht für tot erklären
            if !is_current(&app2, epoch) {
                return;
            }
            let st = app2.state::<NetState>();
            *st.outgoing.lock().unwrap() = None;
            emit_status(&app2, "disconnected");
        })
    }));
}

/// PeerConnection sofort im State verankern und eine eventuell vorhandene
/// schließen. Wird sie erst nach dem ICE-Gathering registriert, ist sie
/// mehrere Sekunden lang für `leave_inner` unsichtbar — sie lebt dann nach
/// einem Abbruch weiter und meldet später eine Verbindung, die niemand mehr
/// erwartet.
fn store_pc(app: &AppHandle, pc: Arc<RTCPeerConnection>) {
    let old = {
        let st = app.state::<NetState>();
        let mut guard = st.pc.lock().unwrap();
        guard.replace(pc)
    };
    if let Some(old) = old {
        tauri::async_runtime::spawn(async move {
            let _ = old.close().await;
        });
    }
}

/// Host: Offer-Code erzeugen (Vanilla-ICE — wartet auf Gathering-complete,
/// der Code enthält damit alle Candidates für den Einmal-Austausch).
#[tauri::command]
async fn webrtc_offer(app: AppHandle) -> Result<String, String> {
    leave_inner(&app);
    let epoch = current_epoch(&app);
    let pc = new_pc(&app).await?;
    store_pc(&app, pc.clone());
    let dc = pc
        .create_data_channel("quodliber", None)
        .await
        .map_err(|e| e.to_string())?;
    wire_datachannel(&app, dc, epoch);

    let offer = pc.create_offer(None).await.map_err(|e| e.to_string())?;
    let mut gather = pc.gathering_complete_promise().await;
    pc.set_local_description(offer)
        .await
        .map_err(|e| e.to_string())?;
    let _ = gather.recv().await;
    let desc = pc
        .local_description()
        .await
        .ok_or("Kein Local-Description-Stand")?;
    let code = encode_desc(&desc)?;
    Ok(code)
}

/// Gast: Offer-Code annehmen, Antwort-Code erzeugen.
#[tauri::command]
async fn webrtc_accept(app: AppHandle, code: String) -> Result<String, String> {
    leave_inner(&app);
    let epoch = current_epoch(&app);
    let pc = new_pc(&app).await?;
    store_pc(&app, pc.clone());

    let app2 = app.clone();
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        wire_datachannel(&app2, dc, epoch);
        Box::pin(async {})
    }));

    let offer = decode_desc(&code)?;
    pc.set_remote_description(offer)
        .await
        .map_err(|e| e.to_string())?;
    let answer = pc.create_answer(None).await.map_err(|e| e.to_string())?;
    let mut gather = pc.gathering_complete_promise().await;
    pc.set_local_description(answer)
        .await
        .map_err(|e| e.to_string())?;
    let _ = gather.recv().await;
    let desc = pc
        .local_description()
        .await
        .ok_or("Kein Local-Description-Stand")?;
    let code = encode_desc(&desc)?;
    Ok(code)
}

/// Host: Antwort-Code des Gasts einspielen — danach verbindet ICE selbstständig.
#[tauri::command]
async fn webrtc_finish(app: AppHandle, code: String) -> Result<(), String> {
    let answer = decode_desc(&code)?;
    let pc = app
        .state::<NetState>()
        .pc
        .lock()
        .unwrap()
        .clone()
        .ok_or("Keine wartende Internet-Session")?;
    pc.set_remote_description(answer)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn host_session(
    app: AppHandle,
    port: u16,
    name: String,
    id: String,
) -> Result<String, String> {
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
    // Erst ansagen, wenn der Port wirklich steht — sonst bewirbt ein
    // gescheiterter Bind eine Session, die es gar nicht gibt
    mdns_announce(&app, port, &name, &id);
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
            pc: Mutex::new(None),
            mdns: Mutex::new(None),
            mdns_fullname: Mutex::new(None),
            epoch: std::sync::atomic::AtomicU64::new(0),
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            recovery_file_path,
            host_session,
            join_session,
            net_send,
            leave_session,
            webrtc_offer,
            webrtc_accept,
            webrtc_finish,
            lan_init
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
