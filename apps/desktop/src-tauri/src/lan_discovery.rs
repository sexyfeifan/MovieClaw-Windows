// MovieClaw Desktop — LAN 服务器发现
// 通过 UDP 广播发现本地网络中的 MovieClaw 服务器

use std::net::{SocketAddr, UdpSocket};
use std::time::Duration;

const DISCOVERY_PORT: u16 = 18800;
const DISCOVERY_MAGIC: &[u8] = b"MOVIECLAW_DISCOVER_V1";
const BROADCAST_ADDR: &str = "255.255.255.255";
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(3);

/// 发送 UDP 广播查找本地 MovieClaw 服务器
#[tauri::command]
pub async fn discover_servers() -> Result<Vec<serde_json::Value>, String> {
    let servers = std::thread::spawn(|| {
        let mut found = Vec::new();

        // 绑定 UDP socket
        let socket = match UdpSocket::bind("0.0.0.0:0") {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[LAN] Bind failed: {e}");
                return found;
            }
        };

        socket.set_broadcast(true).ok();
        socket.set_read_timeout(Some(RESPONSE_TIMEOUT)).ok();

        // 发送广播
        let broadcast_addr: SocketAddr = match format!("{}:{}", BROADCAST_ADDR, DISCOVERY_PORT).parse() {
            Ok(a) => a,
            Err(_) => return found,
        };

        if let Err(e) = socket.send_to(DISCOVERY_MAGIC, broadcast_addr) {
            eprintln!("[LAN] Broadcast failed: {e}");
            return found;
        }

        // 等待响应
        let mut buf = [0u8; 512];
        let start = std::time::Instant::now();

        while start.elapsed() < RESPONSE_TIMEOUT {
            if let Ok((len, from)) = socket.recv_from(&mut buf) {
                let response = String::from_utf8_lossy(&buf[..len]);
                // 响应格式: "MOVIECLAW_SERVER_V1|<name>|<version>|<http_port>"
                if response.starts_with("MOVIECLAW_SERVER_V1") {
                    let parts: Vec<&str> = response.split('|').collect();
                    if parts.len() >= 4 {
                        let name = parts[1].to_string();
                        let version = parts[2].to_string();
                        let port = parts[3].to_string();
                        let ip = from.ip().to_string();
                        let url = format!("http://{}:{}", ip, port);

                        // 去重
                        if !found.iter().any(|s: &serde_json::Value| {
                            s["url"].as_str() == Some(url.as_str())
                        }) {
                            found.push(serde_json::json!({
                                "name": name,
                                "version": version,
                                "url": url,
                                "ip": ip,
                                "port": port
                            }));
                        }
                    }
                }
            }
        }

        found
    })
    .join()
    .unwrap_or_default();

    Ok(servers)
}

/// 应答 LAN 发现请求（服务器端使用，桌面客户端不需要主动应答）
/// 但如果 MovieClaw 服务器在同一台机器上，可以在这里添加本地应答
#[allow(dead_code)]
fn start_responder() {
    std::thread::spawn(|| {
        let socket = match UdpSocket::bind(format!("0.0.0.0:{}", DISCOVERY_PORT)) {
            Ok(s) => s,
            Err(_) => return,
        };
        let mut buf = [0u8; 256];
        loop {
            if let Ok((len, from)) = socket.recv_from(&mut buf) {
                let msg = String::from_utf8_lossy(&buf[..len]);
                if msg.trim() == std::str::from_utf8(DISCOVERY_MAGIC).unwrap_or("") {
                    // 这里不主动应答，因为桌面端是客户端不是服务器
                    // 如果需要应答，服务器端会响应
                    eprintln!("[LAN] Discovery probe from {}", from);
                }
            }
        }
    });
}
