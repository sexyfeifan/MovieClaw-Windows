/// 代理前端 API 请求到 MovieClaw 服务器，绕过 CORS 限制
#[tauri::command]
pub async fn proxy_api(
    method: String,
    path: String,
    body: Option<String>,
    content_type: Option<String>,
) -> Result<ProxyResponse, String> {
    let server = crate::connect::load_server_url()
        .map_err(|e| format!("获取服务器地址失败: {e}"))?;

    if server.is_empty() {
        return Err("未配置服务器地址".into());
    }

    let url = format!("{}/api/v1{}", server.trim_end_matches('/'), path);

    let mut req = ureq::request(&method, &url)
        .set("Accept", "application/json");

    if let Some(ct) = &content_type {
        req = req.set("Content-Type", ct);
    }

    let result = match (body, method.to_uppercase().as_str()) {
        (Some(b), "POST") | (Some(b), "PUT") | (Some(b), "PATCH") => req.send_string(&b),
        _ => req.call(),
    };

    match result {
        Ok(resp) => {
            let status = resp.status();
            let text = resp.into_string().unwrap_or_default();
            Ok(ProxyResponse { status, body: text })
        }
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            Ok(ProxyResponse { status: code, body: text })
        }
        Err(e) => Err(format!("请求失败: {e}")),
    }
}

#[derive(serde::Serialize)]
pub struct ProxyResponse {
    pub status: u16,
    pub body: String,
}
