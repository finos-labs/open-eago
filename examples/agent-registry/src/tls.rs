use crate::models::SpireConfig;
use openssl::ssl::{SslAcceptor, SslFiletype, SslMethod, SslVerifyMode};
use std::path::Path;
use std::sync::Arc;
use tracing::{debug, info};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Server cert verifier that validates the chain against the SPIRE CA bundle but
/// skips hostname verification. Used by the Swagger proxy when connecting to
/// https://127.0.0.1:8443: the backend presents a SPIRE SVID with SPIFFE URI SAN,
/// not 127.0.0.1, so hostname check would fail otherwise.
#[derive(Debug)]
struct SpireProxyServerVerifier {
    roots: Arc<rustls::RootCertStore>,
    supported_algs: rustls::crypto::WebPkiSupportedAlgorithms,
}

impl rustls::client::danger::ServerCertVerifier for SpireProxyServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> std::result::Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let cert = rustls::server::ParsedCertificate::try_from(end_entity)?;
        rustls::client::verify_server_cert_signed_by_trust_anchor(
            &cert,
            &self.roots,
            intermediates,
            now,
            self.supported_algs.all,
        )?;
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.supported_algs)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.supported_algs)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.supported_algs.supported_schemes()
    }
}

/// Build a reqwest client that presents the SPIRE SVID as a client certificate.
/// For the Swagger proxy we use a custom server verifier that validates the
/// backend cert chain against the SPIRE CA but skips hostname verification
/// (backend at 127.0.0.1 presents a SPIRE SVID with SPIFFE URI SAN). Other callers
/// (e.g. sync) get full hostname verification via with_root_certificates.
/// Called per sync-round so SPIRE cert rotation is picked up at the next interval.
pub fn build_mtls_client(spire: &SpireConfig) -> Result<reqwest::Client> {
    build_mtls_client_inner(spire, true)
}

/// Build mTLS client for the Swagger proxy: same as build_mtls_client but uses
/// a custom server verifier that skips hostname check so proxy→127.0.0.1 works.
pub fn build_mtls_client_for_proxy(spire: &SpireConfig) -> Result<reqwest::Client> {
    build_mtls_client_inner(spire, false)
}

fn build_mtls_client_inner(spire: &SpireConfig, verify_hostname: bool) -> Result<reqwest::Client> {
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
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
    let roots = Arc::new(roots);

    // Parse client certificate chain (presented during mTLS handshake)
    let certs: Vec<CertificateDer<'static>> =
        rustls_pemfile::certs(&mut cert_pem.as_slice())
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| format!("Invalid client cert: {}", e))?;

    // SPIRE issues PKCS#8 keys (BEGIN PRIVATE KEY)
    let key = rustls_pemfile::private_key(&mut key_pem.as_slice())
        .map_err(|e| format!("Cannot parse private key: {}", e))?
        .ok_or("No private key found in SVID key file")?;
    let key: PrivateKeyDer<'static> = key.into();

    let tls_config = if verify_hostname {
        ClientConfig::builder()
            .with_root_certificates(roots)
            .with_client_auth_cert(certs, key)
            .map_err(|e| format!("Invalid client cert/key pair: {}", e))?
    } else {
        let supported_algs = rustls::crypto::ring::default_provider().signature_verification_algorithms;
        let verifier = Arc::new(SpireProxyServerVerifier {
            roots,
            supported_algs,
        });
        ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_client_auth_cert(certs, key)
            .map_err(|e| format!("Invalid client cert/key pair: {}", e))?
    };

    let mut builder = reqwest::Client::builder().use_preconfigured_tls(tls_config);
    // Proxy only: disable connection pooling so we don't reuse a connection the backend
    // may have closed after the previous response (avoids /list failing after /health).
    if !verify_hostname {
        builder = builder
            .pool_max_idle_per_host(0)
            .pool_idle_timeout(std::time::Duration::ZERO);
    }
    builder
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
