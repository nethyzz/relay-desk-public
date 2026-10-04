import { spawnSync } from 'node:child_process';

// urllib reads macOS System Settings as well as environment proxy variables.
// Keep proxy credentials in process memory, never in a config file or log.
export function localNetworkEnvironment(pythonExecutable, original = process.env) {
  let proxies = {};
  let tun = false;
  try {
    const code = `import json, socket, urllib.request
from runner.network import proxy_dns_addresses
proxies = urllib.request.getproxies()
tun = False
try:
 addresses = [item[4][0] for item in socket.getaddrinfo('cloudflare-dns.com',443,type=socket.SOCK_STREAM)]
 if proxy_dns_addresses(addresses):
  opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
  request = urllib.request.Request('https://cloudflare-dns.com/dns-query?name=example.com&type=1',headers={'Accept':'application/dns-json'})
  with opener.open(request,timeout=4) as response:
   data = json.loads(response.read(65536))
   tun = data.get('Status') == 0 and any(answer.get('type') == 1 for answer in data.get('Answer',[]))
except Exception:
 pass
print(json.dumps({'proxies':proxies,'tun':tun}))`;
    const result = spawnSync(pythonExecutable, ['-c', code], { encoding: 'utf8', env: original, timeout: 6000 });
    if (result.status === 0) { const discovered = JSON.parse(result.stdout); proxies = discovered.proxies; tun = discovered.tun; }
  } catch { /* An explicit environment proxy still works if Python is unavailable. */ }
  const env = { ...original };
  const explicitProxy = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'].some(key => original[key]);
  if (tun && !explicitProxy) {
    // A verified local TUN route avoids a stale/incompatible system CONNECT
    // proxy. This changes only child processes, never macOS network settings.
    env.NO_PROXY = env.no_proxy = '*';
    env.RELAY_LOCAL_NETWORK_MODE = 'tun';
    return env;
  }
  for (const protocol of ['http', 'https']) {
    const proxy = original[protocol + '_proxy'] || original[protocol.toUpperCase() + '_PROXY'] || proxies[protocol] || original.all_proxy || original.ALL_PROXY;
    if (proxy && /^https?:\/\//i.test(proxy)) {
      env[protocol + '_proxy'] = proxy;
      env[protocol.toUpperCase() + '_PROXY'] = proxy;
    }
  }
  const bypass = [original.no_proxy || original.NO_PROXY || '', '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',');
  env.NO_PROXY = env.no_proxy = bypass;
  return env;
}
