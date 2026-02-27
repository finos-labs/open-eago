use crate::models::SpireConfig;
use openssl::ssl::{SslAcceptor, SslFiletype, SslMethod, SslVerifyMode};
use std::path::Path;
use tracing::{debug, info};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Build a reqwest client that presents the SPIRE SVID as a client certificate.
/// Uses rustls so cert-chain trust is enforced without disabling hostname checks globally.
/// SPIFFE URI SANs (spiffe://...) are validated via CA-bundle trust, not DNS hostname matching.
/// Called per sync-round so SPIRE cert rotation is picked up at the next interval.
pub fn build_mtls_client(spire: &SpireConfig) -> Result<reqwest::Client> {
    use rustls::pki_types::CertificateDer;
    use rustls::{ClientConfig, RootCertStore};

    let cert_pem = std::fs::read(&spire.cert_path)
        .map_err(|e| format!("Cannot read SVID cert {}: {}", spire.cert_path, e))?;
    let key_pem = std::fs::read(&spire.key_path)
        .map_err(|e| format!("Cannot read SVID key {}: {}", spire.key_path, e))?;
    let ca_pem = std::fs::read(&spire.bundle_path)
        .map_err(|e| format!("Cannot read CA bundle {}: {}", spire.bundle_path, e))?;

    // Build trusted CA root store from SPIRE CA bundle
    let mut roots = RootCertStore::empty();
    for cert in rustls_pemfile::certs(&mut ca_pem.as_slice()) {
        roots.add(cert.map_err(|e| format!("Invalid CA cert in bundle: {}", e))?)
            .map_err(|e| format!("Cannot add CA cert to store: {}", e))?;
    }

    // Parse client certificate chain (presented during mTLS handshake)
    let certs: Vec<CertificateDer<'static>> =
        rustls_pemfile::certs(&mut cert_pem.as_slice())
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| format!("Invalid client cert: {}", e))?;

    // SPIRE issues PKCS#8 keys (BEGIN PRIVATE KEY)
    let key = rustls_pemfile::private_key(&mut key_pem.as_slice())
        .map_err(|e| format!("Cannot parse private key: {}", e))?
        .ok_or("No private key found in SVID key file")?;

    let tls_config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_client_auth_cert(certs, key)
        .map_err(|e| format!("Invalid client cert/key pair: {}", e))?;

    reqwest::Client::builder()
        .use_preconfigured_tls(tls_config)
        // No danger_accept_invalid_hostnames: rustls enforces CA-chain trust.
        // SPIFFE URI SAN identity is validated through the SPIRE CA bundle.
        .build()
        .map_err(|e| format!("Failed to build mTLS reqwest client: {}", e).into())
}

pub fn load_spire_tls_config(spire: &SpireConfig) -> Result<openssl::ssl::SslAcceptorBuilder> {
    info!("Loading SPIRE certificates for mTLS...");

    if !Path::new(&spire.cert_path).exists() {
        return Err(format!("SPIRE certificate not found at {}", spire.cert_path).into());
    }
    if !Path::new(&spire.key_path).exists() {
        return Err(format!("SPIRE key not found at {}", spire.key_path).into());
    }
    if !Path::new(&spire.bundle_path).exists() {
        return Err(format!("SPIRE CA bundle not found at {}", spire.bundle_path).into());
    }

    let mut builder = SslAcceptor::mozilla_intermediate_v5(SslMethod::tls())?;
    builder.set_certificate_chain_file(&spire.cert_path)?;
    builder.set_private_key_file(&spire.key_path, SslFiletype::PEM)?;
    builder.set_ca_file(&spire.bundle_path)?;
    builder.set_verify(SslVerifyMode::PEER | SslVerifyMode::FAIL_IF_NO_PEER_CERT);

    info!("✓ SPIRE certificates loaded");
    debug!("  cert={} key={} CA={}", spire.cert_path, spire.key_path, spire.bundle_path);

    Ok(builder)
}
