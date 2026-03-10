/**
 * vault-signer.js
 *
 * HSM / Vault signing shim for oracle bridges.
 *
 * Replaces `new ethers.Wallet(privateKey, provider)` with a factory that
 * supports two backends:
 *
 *   "local"  — wraps ethers.Wallet (dev / CI). Same behaviour as before;
 *              private key is read from config.privateKey.
 *
 *   "vault"  — VaultSigner: extends ethers.AbstractSigner, delegates all
 *              signing operations to an HTTP signing endpoint (HashiCorp Vault
 *              Transit, AWS KMS, Azure Key Vault, or any compatible REST API).
 *              The private key never leaves the vault process.
 *
 * Usage in bridges:
 *
 *   import { createSigner } from './vault-signer.js';
 *
 *   const signer = await createSigner({
 *     type:       process.env.SIGNER_TYPE ?? 'local',   // 'local' | 'vault'
 *     privateKey: process.env.ORACLE_PRIVATE_KEY,       // used when type=local
 *     vaultUrl:   process.env.VAULT_URL,                // used when type=vault
 *     address:    process.env.ORACLE_ADDRESS,           // used when type=vault
 *   }, provider);
 *
 * The returned object implements the full ethers.Signer interface, so it can
 * be passed to `new ethers.Contract(address, abi, signer)` unchanged.
 */

import { ethers } from 'ethers';

// ── VaultSigner ───────────────────────────────────────────────────────────────

/**
 * Signer backed by an HTTP signing endpoint.
 *
 * Expected endpoint contract (POST ${vaultUrl}/sign):
 *   Request:  { "hash": "0x..." }           — hex-encoded 32-byte hash
 *   Response: { "signature": "0x..." }      — 65-byte ECDSA signature (r, s, v)
 *
 * This matches the HashiCorp Vault Transit sign API response shape after
 * adapting the base64-encoded signature. Production deployments should add
 * mTLS client certificates and vault token authentication headers.
 */
class VaultSigner extends ethers.AbstractSigner {
  #vaultUrl;
  #address;

  constructor(vaultUrl, address, provider) {
    super(provider);
    this.#vaultUrl = vaultUrl;
    this.#address  = address;
  }

  async getAddress() {
    return this.#address;
  }

  connect(provider) {
    return new VaultSigner(this.#vaultUrl, this.#address, provider);
  }

  async signTransaction(tx) {
    const populated = await this.populateTransaction(tx);
    const unsignedTx = ethers.Transaction.from(populated);
    const hash = ethers.keccak256(unsignedTx.unsignedSerialized);
    const signature = await this.#remoteSign(hash);
    unsignedTx.signature = signature;
    return unsignedTx.serialized;
  }

  async signMessage(message) {
    const hash = typeof message === 'string'
      ? ethers.hashMessage(message)
      : ethers.hashMessage(ethers.toUtf8String(message));
    return this.#remoteSign(hash);
  }

  async signTypedData(domain, types, value) {
    const hash = ethers.TypedDataEncoder.hash(domain, types, value);
    return this.#remoteSign(hash);
  }

  async #remoteSign(hash) {
    const res = await fetch(`${this.#vaultUrl}/sign`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ hash }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`VaultSigner: signing endpoint returned ${res.status}: ${text}`);
    }
    const json = await res.json();
    if (!json.signature) throw new Error('VaultSigner: response missing "signature" field');
    return json.signature;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * @param {object} config
 * @param {string} config.type        'local' | 'vault'
 * @param {string} [config.privateKey] Required when type='local'
 * @param {string} [config.vaultUrl]   Required when type='vault' (e.g. 'http://vault:8200/v1/transit/keys/oracle')
 * @param {string} [config.address]    Required when type='vault' — the oracle wallet address
 * @param {ethers.Provider} provider
 * @returns {ethers.Signer}
 */
export function createSigner(config, provider) {
  const type = config.type ?? 'local';

  if (type === 'local') {
    if (!config.privateKey) throw new Error('vault-signer: config.privateKey required for type=local');
    return new ethers.Wallet(config.privateKey, provider);
  }

  if (type === 'vault') {
    if (!config.vaultUrl) throw new Error('vault-signer: config.vaultUrl required for type=vault');
    if (!config.address)  throw new Error('vault-signer: config.address required for type=vault');
    return new VaultSigner(config.vaultUrl, config.address, provider);
  }

  throw new Error(`vault-signer: unknown type "${type}". Use 'local' or 'vault'.`);
}
