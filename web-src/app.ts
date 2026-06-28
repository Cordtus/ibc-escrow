import {
  type BalanceRow,
  type BalancesResponse,
  buildBalancesPath,
  buildChannelDetails,
  buildChannelPath,
  buildClientStatePath,
  buildConnectionPath,
  buildEscrowAddressPath,
  buildLookupUrl,
  type ChainSummary,
  type ChannelDetails,
  type ChannelResponse,
  type ClientStateResponse,
  type ConnectionResponse,
  type EndpointMode,
  extractClientId,
  extractConnectionId,
  getNextBalancePageKey,
  type LookupUrlOptions,
  normalizeBalances,
  normalizeBaseUrl,
  normalizeChainSummaries,
} from './lookup.js';

interface AppSettings {
  chainName: string;
  channelId: string;
  portId: string;
  endpointMode: EndpointMode;
  lazyLbBaseUrl: string;
  directRestBaseUrl: string;
  includeDetails: boolean;
}

interface EscrowAddressResponse {
  escrow_address?: string;
}

interface HistoryEntry {
  chainName: string;
  channelId: string;
  portId: string;
  escrowAddress: string;
  source: string;
  timestamp: number;
}

const STORAGE_KEY = 'ibc-escrow-web-settings';
const HISTORY_KEY = 'ibc-escrow-web-history';
const HOSTED_LAZY_LB_BASE_URL = 'https://ibc-escrow.cac-group.io';
const FALLBACK_CHAINS: ChainSummary[] = [
  {
    name: 'cosmoshub',
    chainId: 'cosmoshub-4',
    bech32Prefix: 'cosmos',
    endpointCount: 0,
    rpcCount: 0,
    restCount: 0,
  },
  {
    name: 'osmosis',
    chainId: 'osmosis-1',
    bech32Prefix: 'osmo',
    endpointCount: 0,
    rpcCount: 0,
    restCount: 0,
  },
  {
    name: 'noble',
    chainId: 'noble-1',
    bech32Prefix: 'noble',
    endpointCount: 0,
    rpcCount: 0,
    restCount: 0,
  },
];

function getDefaultLazyLbBaseUrl(): string {
  const origin = window.location.origin;
  if (origin === HOSTED_LAZY_LB_BASE_URL) {
    return origin;
  }

  return HOSTED_LAZY_LB_BASE_URL;
}

function getDefaultSettings(): AppSettings {
  return {
    chainName: 'cosmoshub',
    channelId: 'channel-141',
    portId: 'transfer',
    endpointMode: 'auto',
    lazyLbBaseUrl: getDefaultLazyLbBaseUrl(),
    directRestBaseUrl: '',
    includeDetails: true,
  };
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }

  return element as T;
}

const form = byId<HTMLFormElement>('lookup-form');
const chainInput = byId<HTMLInputElement>('chain-name');
const channelInput = byId<HTMLInputElement>('channel-id');
const portInput = byId<HTMLInputElement>('port-id');
const endpointModeInput = byId<HTMLSelectElement>('endpoint-mode');
const lazyLbInput = byId<HTMLInputElement>('lazy-lb-base-url');
const directRestField = byId<HTMLElement>('direct-rest-field');
const directRestInput = byId<HTMLInputElement>('direct-rest-base-url');
const includeDetailsInput = byId<HTMLInputElement>('include-details');
const submitButton = byId<HTMLButtonElement>('lookup-button');
const resetButton = byId<HTMLButtonElement>('reset-button');
const statusText = byId<HTMLSpanElement>('status-text');
const statusDot = byId<HTMLSpanElement>('status-dot');
const resultPanel = byId<HTMLElement>('result-panel');
const resultBody = byId<HTMLElement>('result-body');
const balancesPanel = byId<HTMLElement>('balances-panel');
const balancesTitle = byId<HTMLElement>('balances-title');
const balancesBody = byId<HTMLElement>('balances-body');
const detailPanel = byId<HTMLElement>('detail-panel');
const detailBody = byId<HTMLElement>('detail-body');
const tracePanel = byId<HTMLElement>('trace-panel');
const traceBody = byId<HTMLElement>('trace-body');
const historyBody = byId<HTMLElement>('history-body');
const chainOptions = byId<HTMLDataListElement>('chain-options');
const chainSummaryStatus = byId<HTMLElement>('chain-summary-status');

function loadSettings(): AppSettings {
  const defaults = getDefaultSettings();
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<AppSettings>;
    return {
      ...defaults,
      ...parsed,
      lazyLbBaseUrl: parsed.lazyLbBaseUrl?.trim() || defaults.lazyLbBaseUrl,
    };
  } catch {
    return defaults;
  }
}

function saveSettings(settings: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function readSettings(): AppSettings {
  return {
    chainName: chainInput.value.trim(),
    channelId: channelInput.value.trim(),
    portId: portInput.value.trim() || 'transfer',
    endpointMode: endpointModeInput.value as EndpointMode,
    lazyLbBaseUrl: lazyLbInput.value.trim(),
    directRestBaseUrl: directRestInput.value.trim(),
    includeDetails: includeDetailsInput.checked,
  };
}

function applySettings(settings: AppSettings): void {
  chainInput.value = settings.chainName;
  channelInput.value = settings.channelId;
  portInput.value = settings.portId;
  endpointModeInput.value = settings.endpointMode;
  lazyLbInput.value = settings.lazyLbBaseUrl;
  directRestInput.value = settings.directRestBaseUrl;
  includeDetailsInput.checked = settings.includeDetails;
  updateEndpointFields();
}

function setStatus(message: string, state: 'idle' | 'busy' | 'ok' | 'error' = 'idle'): void {
  statusText.textContent = message;
  statusDot.dataset.state = state;
}

function setBusy(isBusy: boolean): void {
  submitButton.disabled = isBusy;
  resetButton.disabled = isBusy;
  form.toggleAttribute('aria-busy', isBusy);
}

function buildLookupOptions(settings: AppSettings): LookupUrlOptions {
  return {
    chainName: settings.chainName,
    endpointMode: settings.endpointMode,
    lazyLbBaseUrl: settings.lazyLbBaseUrl || getDefaultLazyLbBaseUrl(),
    directRestBaseUrl: settings.directRestBaseUrl,
  };
}

function getDefaultDirectRestBaseUrl(): string {
  return `https://rest.cosmos.directory/${encodeURIComponent(chainInput.value.trim() || 'cosmoshub')}`;
}

function updateEndpointFields(): void {
  const directRestSelected = endpointModeInput.value === 'direct-rest';
  directRestField.hidden = !directRestSelected;
  directRestInput.placeholder = getDefaultDirectRestBaseUrl();
}

function buildServiceUrl(path: string): string {
  const baseUrl = normalizeBaseUrl(lazyLbInput.value || getDefaultLazyLbBaseUrl());
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }

    return await response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

function clearNode(node: HTMLElement): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function appendKeyValue(parent: HTMLElement, label: string, value: string, canCopy = false): void {
  const row = document.createElement('div');
  row.className = 'kv-row';

  const key = document.createElement('span');
  key.className = 'kv-key';
  key.textContent = label;

  const val = document.createElement('span');
  val.className = 'kv-value';
  val.textContent = value || '-';

  row.append(key, val);

  if (canCopy && value) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'small-button';
    button.textContent = 'Copy';
    button.addEventListener('click', () => navigator.clipboard.writeText(value));
    row.append(button);
  }

  parent.append(row);
}

function appendRequest(parent: HTMLElement, label: string, url: string): void {
  const item = document.createElement('div');
  item.className = 'trace-row';

  const name = document.createElement('span');
  name.className = 'trace-label';
  name.textContent = label;

  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = url;

  item.append(name, link);
  parent.append(item);
}

function renderChainOptions(chains: ChainSummary[]): void {
  clearNode(chainOptions);

  for (const chain of chains) {
    const option = document.createElement('option');
    option.value = chain.name;
    option.label = `${chain.chainId} · REST ${chain.restCount} · RPC ${chain.rpcCount}`;
    chainOptions.append(option);
  }
}

async function loadChainSummaries(): Promise<void> {
  try {
    const data = await fetchJson(buildServiceUrl('/api/chains-summary'));
    const chains = normalizeChainSummaries(data);
    if (chains.length === 0) {
      throw new Error('No chain summaries returned');
    }

    renderChainOptions(chains);
    chainSummaryStatus.textContent = `${chains.length} registry chains`;
  } catch {
    renderChainOptions(FALLBACK_CHAINS);
    chainSummaryStatus.textContent = 'Registry list unavailable';
  }
}

function renderEscrowResult(settings: AppSettings, escrowAddress: string, source: string): void {
  clearNode(resultBody);
  appendKeyValue(resultBody, 'Chain', settings.chainName);
  appendKeyValue(resultBody, 'Port / channel', `${settings.portId}/${settings.channelId}`);
  appendKeyValue(resultBody, 'Escrow address', escrowAddress, true);
  appendKeyValue(resultBody, 'Source', source);
  resultPanel.hidden = false;
}

function renderChannelDetails(details: ChannelDetails): void {
  clearNode(detailBody);
  appendKeyValue(detailBody, 'Counterparty channel', details.counterpartyChannelId);
  appendKeyValue(detailBody, 'Counterparty port', details.counterpartyPortId);
  appendKeyValue(detailBody, 'Connection', details.connectionId);
  appendKeyValue(detailBody, 'Client', details.clientId);
  appendKeyValue(detailBody, 'Counterparty client', details.counterpartyClientId);
  appendKeyValue(detailBody, 'Counterparty connection', details.counterpartyConnectionId);
  appendKeyValue(detailBody, 'Counterparty chain', details.counterpartyChainId);
  appendKeyValue(detailBody, 'Ordering', details.ordering);
  appendKeyValue(detailBody, 'Version', details.version);
  detailPanel.hidden = false;
}

function renderBalances(balances: BalanceRow[]): void {
  clearNode(balancesBody);
  balancesTitle.textContent = `Balances (${balances.length})`;

  if (balances.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No balances returned for this escrow account';
    balancesBody.append(empty);
    balancesPanel.hidden = false;
    return;
  }

  for (const balance of balances) {
    const row = document.createElement('div');
    row.className = 'balance-row';

    const amount = document.createElement('span');
    amount.className = 'balance-amount';
    amount.textContent = balance.amount;

    const denom = document.createElement('span');
    denom.className = 'balance-denom';
    denom.textContent = balance.denom;

    row.append(amount, denom);
    balancesBody.append(row);
  }

  balancesPanel.hidden = false;
}

async function fetchAllBalances(
  options: LookupUrlOptions,
  escrowAddress: string,
  requests: Array<{ label: string; url: string }>
): Promise<BalanceRow[]> {
  const balances: BalanceRow[] = [];
  let paginationKey: string | undefined;

  for (let page = 0; page < 20; page += 1) {
    const balancesRequest = buildLookupUrl(
      options,
      buildBalancesPath(escrowAddress, paginationKey)
    );
    requests.push({
      label: page === 0 ? 'balances' : `balances ${page + 1}`,
      url: balancesRequest.url,
    });
    const balancesData = (await fetchJson(balancesRequest.url)) as BalancesResponse;
    balances.push(...normalizeBalances(balancesData));

    paginationKey = getNextBalancePageKey(balancesData);
    if (!paginationKey) {
      return balances;
    }
  }

  throw new Error('Balance lookup exceeded pagination limit');
}

function renderTrace(requests: Array<{ label: string; url: string }>): void {
  clearNode(traceBody);
  for (const request of requests) {
    appendRequest(traceBody, request.label, request.url);
  }
  tracePanel.hidden = requests.length === 0;
}

function loadHistory(): HistoryEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') as HistoryEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, 6) : [];
  } catch {
    return [];
  }
}

function saveHistory(entry: HistoryEntry): void {
  const history = loadHistory().filter(
    (item) =>
      !(
        item.chainName === entry.chainName &&
        item.channelId === entry.channelId &&
        item.portId === entry.portId
      )
  );
  localStorage.setItem(HISTORY_KEY, JSON.stringify([entry, ...history].slice(0, 6)));
}

function renderHistory(): void {
  clearNode(historyBody);
  const history = loadHistory();

  if (history.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No recent lookups';
    historyBody.append(empty);
    return;
  }

  for (const item of history) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-button';
    button.textContent = `${item.chainName} ${item.channelId}`;
    button.addEventListener('click', () => {
      chainInput.value = item.chainName;
      channelInput.value = item.channelId;
      portInput.value = item.portId;
      updateEndpointFields();
      setStatus(`Loaded ${item.chainName} ${item.channelId}`, 'idle');
    });
    historyBody.append(button);
  }
}

async function runLookup(settings: AppSettings): Promise<void> {
  const options = buildLookupOptions(settings);
  const requests: Array<{ label: string; url: string }> = [];

  setStatus('Querying escrow address', 'busy');
  const escrowPath = buildEscrowAddressPath(settings.channelId, settings.portId);
  const escrowRequest = buildLookupUrl(options, escrowPath);
  requests.push({ label: 'escrow', url: escrowRequest.url });
  const escrowData = (await fetchJson(escrowRequest.url)) as EscrowAddressResponse;

  if (!escrowData.escrow_address) {
    throw new Error('Escrow address was not returned');
  }

  renderEscrowResult(settings, escrowData.escrow_address, escrowRequest.source);

  setStatus('Querying escrow balances', 'busy');
  const balances = await fetchAllBalances(options, escrowData.escrow_address, requests);
  renderBalances(balances);

  if (settings.includeDetails) {
    setStatus('Querying channel details', 'busy');
    const channelRequest = buildLookupUrl(
      options,
      buildChannelPath(settings.channelId, settings.portId)
    );
    requests.push({ label: 'channel', url: channelRequest.url });
    const channelData = (await fetchJson(channelRequest.url)) as ChannelResponse;
    const connectionId = extractConnectionId(channelData);

    const connectionRequest = buildLookupUrl(options, buildConnectionPath(connectionId));
    requests.push({ label: 'connection', url: connectionRequest.url });
    const connectionData = (await fetchJson(connectionRequest.url)) as ConnectionResponse;
    const clientId = extractClientId(connectionData);

    const clientRequest = buildLookupUrl(options, buildClientStatePath(clientId));
    requests.push({ label: 'client', url: clientRequest.url });
    const clientStateData = (await fetchJson(clientRequest.url)) as ClientStateResponse;

    renderChannelDetails(buildChannelDetails(channelData, connectionData, clientStateData));
  } else {
    clearNode(detailBody);
    detailPanel.hidden = true;
  }

  renderTrace(requests);
  saveHistory({
    chainName: settings.chainName,
    channelId: settings.channelId,
    portId: settings.portId,
    escrowAddress: escrowData.escrow_address,
    source: escrowRequest.source,
    timestamp: Date.now(),
  });
  renderHistory();
  setStatus('Lookup complete', 'ok');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = readSettings();
  saveSettings(settings);
  setBusy(true);

  try {
    await runLookup(settings);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Lookup failed', 'error');
  } finally {
    setBusy(false);
  }
});

resetButton.addEventListener('click', () => {
  const defaultSettings = getDefaultSettings();
  applySettings(defaultSettings);
  saveSettings(defaultSettings);
  clearNode(resultBody);
  clearNode(balancesBody);
  balancesTitle.textContent = 'Balances';
  clearNode(detailBody);
  clearNode(traceBody);
  resultPanel.hidden = true;
  balancesPanel.hidden = true;
  detailPanel.hidden = true;
  tracePanel.hidden = true;
  setStatus('Ready', 'idle');
});

endpointModeInput.addEventListener('change', updateEndpointFields);
chainInput.addEventListener('input', updateEndpointFields);

document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) => {
  button.addEventListener('click', () => {
    const [chainName, channelId] = (button.dataset.preset || '').split(':');
    if (!chainName || !channelId) return;
    chainInput.value = chainName;
    channelInput.value = channelId;
    portInput.value = 'transfer';
    updateEndpointFields();
    setStatus(`Loaded ${chainName} ${channelId}`, 'idle');
  });
});

applySettings(loadSettings());
void loadChainSummaries();
renderHistory();
setStatus('Ready', 'idle');
