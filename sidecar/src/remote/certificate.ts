import { execFile } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function createRemoteCertificate(address: string) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) throw new Error('An IPv4 interface is required.');
  const directory = await mkdtemp(join(tmpdir(), 'droidex-tls-'));
  try {
    const config = join(directory, 'openssl.cnf');
    const keyPath = join(directory, 'key.pem');
    const certPath = join(directory, 'cert.pem');
    await writeFile(config, [
      '[req]', 'prompt=no', 'distinguished_name=dn', 'x509_extensions=ext',
      '[dn]', 'CN=DROIDEX Remote', '[ext]', 'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth',
      `subjectAltName=IP:${address}`, '',
    ].join('\n'), { mode: 0o600 });
    await execute(process.env.DROIDEX_OPENSSL_PATH || 'openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '14',
      '-keyout', keyPath, '-out', certPath, '-config', config,
    ], { timeout: 15_000, windowsHide: true, maxBuffer: 64 * 1024 });
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
    const fingerprint = createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
    return { key, cert, fingerprint };
  } catch (cause) {
    throw new Error('Could not create the encrypted connection. Install OpenSSL or set DROIDEX_OPENSSL_PATH to its executable.', { cause });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
