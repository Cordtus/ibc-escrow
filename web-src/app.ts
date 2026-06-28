import {
  type BalanceRow,
  type BalancesResponse,
  buildBalancesPath,
  buildChannelDetails,
  buildChannelPath,
  buildClientStatePath,
  buildConnectionPath,
  buildDestinationIbcDenom,
  buildEscrowAddressPath,
  buildLookupUrl,
  buildSupplyByDenomPath,
  type ChainSummary,
  type ChannelDetails,
  type ChannelResponse,
  type ClientStateResponse,
  type ConnectionResponse,
  type EndpointMode,
  extractClientId,
  extractConnectionId,
  getChainMetadataFeedback,
  getNextBalancePageKey,
  type IbcLinksResponse,
  type LookupUrlOptions,
  normalizeBalances,
  normalizeBaseUrl,
  normalizeChainSelection,
  normalizeChainSummaries,
  normalizeSupplyAmount,
  type ResolvedLookupRoute,
  resolveLookupRoute,
  type StatusState,
  type SupplyResponse,
} from './lookup.js';

interface AppSettings {
  sourceChainName: string;
  destinationChainName: string;
  channelId: string;
  portId: string;
  endpointMode: EndpointMode;
  lazyLbBaseUrl: string;
  sourceDirectRestBaseUrl: string;
  destinationDirectRestBaseUrl: string;
  includeDetails: boolean;
}

interface EscrowAddressResponse {
  escrow_address?: string;
}

interface HistoryEntry {
  sourceChainName: string;
  destinationChainName: string;
  channelId: string;
  portId: string;
  escrowAddress: string;
  source: string;
  timestamp: number;
}

interface SupplyComparisonRow {
  denom: string;
  amount: string;
  destinationDenom: string;
  destinationSupply: string;
  delta: string;
  error?: string;
}

const STORAGE_KEY = 'ibc-escrow-web-settings';
const HISTORY_KEY = 'ibc-escrow-web-history';
const HOSTED_LAZY_LB_BASE_URL = 'https://ibc-escrow.cac-group.io';
const MAX_SUPPLY_COMPARISONS = 25;
let chainSummaries: ChainSummary[] = [];
let lookupBusy = false;
let chainControlsDisabled = true;
let lookupDisabledForChains = true;
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
    sourceChainName: 'cosmoshub',
    destinationChainName: 'osmosis',
    channelId: '',
    portId: 'transfer',
    endpointMode: 'auto',
    lazyLbBaseUrl: getDefaultLazyLbBaseUrl(),
    sourceDirectRestBaseUrl: '',
    destinationDirectRestBaseUrl: '',
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
const sourceChainInput = byId<HTMLSelectElement>('source-chain-name');
const destinationChainInput = byId<HTMLSelectElement>('destination-chain-name');
const channelInput = byId<HTMLInputElement>('channel-id');
const portInput = byId<HTMLInputElement>('port-id');
const endpointModeInput = byId<HTMLSelectElement>('endpoint-mode');
const lazyLbInput = byId<HTMLInputElement>('lazy-lb-base-url');
const directRestField = byId<HTMLElement>('direct-rest-field');
const sourceDirectRestInput = byId<HTMLInputElement>('source-direct-rest-base-url');
const destinationDirectRestInput = byId<HTMLInputElement>('destination-direct-rest-base-url');
const chainListNote = byId<HTMLElement>('chain-list-note');
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
const comparisonPanel = byId<HTMLElement>('comparison-panel');
const comparisonTitle = byId<HTMLElement>('comparison-title');
const comparisonBody = byId<HTMLElement>('comparison-body');
const detailPanel = byId<HTMLElement>('detail-panel');
const detailBody = byId<HTMLElement>('detail-body');
const tracePanel = byId<HTMLElement>('trace-panel');
const traceBody = byId<HTMLElement>('trace-body');
const historyBody = byId<HTMLElement>('history-body');

function loadSettings(): AppSettings {
  const defaults = getDefaultSettings();
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<
      AppSettings & {
        chainName: string;
        directRestBaseUrl: string;
      }
    >;
    return {
      ...defaults,
      ...parsed,
      sourceChainName:
        parsed.sourceChainName?.trim() || parsed.chainName?.trim() || defaults.sourceChainName,
      destinationChainName: parsed.destinationChainName?.trim() || defaults.destinationChainName,
      lazyLbBaseUrl: parsed.lazyLbBaseUrl?.trim() || defaults.lazyLbBaseUrl,
      sourceDirectRestBaseUrl:
        parsed.sourceDirectRestBaseUrl?.trim() || parsed.directRestBaseUrl?.trim() || '',
      destinationDirectRestBaseUrl: parsed.destinationDirectRestBaseUrl?.trim() || '',
    };
  } catch {
    return defaults;
  }
}

function saveSettings(settings: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function readSettings(): AppSettings {
  const chains = chainSummaries.length > 0 ? chainSummaries : FALLBACK_CHAINS;
  return {
    sourceChainName: normalizeChainSelection(sourceChainInput.value.trim(), chains),
    destinationChainName: normalizeChainSelection(destinationChainInput.value.trim(), chains),
    channelId: channelInput.value.trim(),
    portId: portInput.value.trim() || 'transfer',
    endpointMode: endpointModeInput.value as EndpointMode,
    lazyLbBaseUrl: lazyLbInput.value.trim(),
    sourceDirectRestBaseUrl: sourceDirectRestInput.value.trim(),
    destinationDirectRestBaseUrl: destinationDirectRestInput.value.trim(),
    includeDetails: includeDetailsInput.checked,
  };
}

function applySettings(settings: AppSettings): void {
  sourceChainInput.value = settings.sourceChainName;
  destinationChainInput.value = settings.destinationChainName;
  channelInput.value = settings.channelId;
  portInput.value = settings.portId;
  endpointModeInput.value = settings.endpointMode;
  lazyLbInput.value = settings.lazyLbBaseUrl;
  sourceDirectRestInput.value = settings.sourceDirectRestBaseUrl;
  destinationDirectRestInput.value = settings.destinationDirectRestBaseUrl;
  includeDetailsInput.checked = settings.includeDetails;
  updateEndpointFields();
}

function setStatus(message: string, state: StatusState = 'idle'): void {
  statusText.textContent = message;
  statusDot.dataset.state = state;
}

function updateControlState(): void {
  const chainsUnavailable = chainControlsDisabled || lookupDisabledForChains;
  submitButton.disabled = lookupBusy || lookupDisabledForChains;
  resetButton.disabled = lookupBusy;
  sourceChainInput.disabled = lookupBusy || chainControlsDisabled;
  destinationChainInput.disabled = lookupBusy || chainControlsDisabled;
  form.toggleAttribute('aria-busy', lookupBusy || chainsUnavailable);
}

function setBusy(isBusy: boolean): void {
  lookupBusy = isBusy;
  updateControlState();
}

function setChainMetadataState(state: 'loading' | 'ready' | 'fallback'): void {
  const feedback = getChainMetadataFeedback(state);
  chainControlsDisabled = feedback.chainControlsDisabled;
  lookupDisabledForChains = feedback.lookupDisabled;
  chainListNote.textContent = feedback.note;
  chainListNote.hidden = !feedback.note;
  chainListNote.dataset.state = state;
  setStatus(feedback.statusMessage, feedback.statusState);
  updateControlState();
}

function buildLookupOptions(
  settings: AppSettings,
  chainName: string,
  side: 'source' | 'destination'
): LookupUrlOptions {
  return {
    chainName,
    endpointMode: settings.endpointMode,
    lazyLbBaseUrl: settings.lazyLbBaseUrl || getDefaultLazyLbBaseUrl(),
    directRestBaseUrl:
      side === 'source' ? settings.sourceDirectRestBaseUrl : settings.destinationDirectRestBaseUrl,
  };
}

function getDefaultDirectRestBaseUrl(chainName: string): string {
  return `https://rest.cosmos.directory/${encodeURIComponent(chainName.trim() || 'cosmoshub')}`;
}

function updateEndpointFields(): void {
  const directRestSelected = endpointModeInput.value === 'direct-rest';
  directRestField.hidden = !directRestSelected;
  sourceDirectRestInput.placeholder = getDefaultDirectRestBaseUrl(
    sourceChainInput.value || 'cosmoshub'
  );
  destinationDirectRestInput.placeholder = getDefaultDirectRestBaseUrl(
    destinationChainInput.value || 'osmosis'
  );
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

function appendChainOption(select: HTMLSelectElement, chain: ChainSummary): void {
  const option = document.createElement('option');
  option.value = chain.name;
  option.textContent = `${chain.name} ${chain.chainId}`.trim();
  option.dataset.chainId = chain.chainId;
  option.dataset.restCount = String(chain.restCount);
  option.dataset.rpcCount = String(chain.rpcCount);
  select.append(option);
}

function renderChainLoadingSelect(
  select: HTMLSelectElement,
  selectedValue: string,
  placeholderText: string
): void {
  clearNode(select);
  const option = document.createElement('option');
  option.value = selectedValue;
  option.textContent = placeholderText;
  option.disabled = true;
  select.append(option);
  select.value = selectedValue;
}

function renderChainLoadingOptions(settings: AppSettings): void {
  const feedback = getChainMetadataFeedback('loading');
  renderChainLoadingSelect(sourceChainInput, settings.sourceChainName, feedback.placeholderText);
  renderChainLoadingSelect(
    destinationChainInput,
    settings.destinationChainName,
    feedback.placeholderText
  );
  updateEndpointFields();
}

function renderChainSelect(
  select: HTMLSelectElement,
  chains: ChainSummary[],
  fallback: string
): void {
  const selectedChain = select.value || fallback;
  clearNode(select);

  for (const chain of chains) {
    appendChainOption(select, chain);
  }

  if (!chains.some((chain) => chain.name === selectedChain)) {
    const option = document.createElement('option');
    option.value = selectedChain;
    option.textContent = selectedChain;
    select.prepend(option);
  }

  select.value = selectedChain;
}

function renderChainOptions(chains: ChainSummary[]): void {
  renderChainSelect(sourceChainInput, chains, 'cosmoshub');
  renderChainSelect(destinationChainInput, chains, 'osmosis');
  updateEndpointFields();
}

async function loadChainSummaries(): Promise<void> {
  setChainMetadataState('loading');
  try {
    const data = await fetchJson(buildServiceUrl('/api/chains-summary'));
    const chains = normalizeChainSummaries(data);
    if (chains.length === 0) {
      throw new Error('No chain summaries returned');
    }

    chainSummaries = chains;
    renderChainOptions(chains);
    setChainMetadataState('ready');
  } catch {
    chainSummaries = FALLBACK_CHAINS;
    renderChainOptions(FALLBACK_CHAINS);
    setChainMetadataState('fallback');
  }
}

function renderEscrowResult(
  route: ResolvedLookupRoute,
  escrowAddress: string,
  source: string
): void {
  clearNode(resultBody);
  appendKeyValue(resultBody, 'Source chain', route.sourceChainName);
  appendKeyValue(resultBody, 'Destination chain', route.destinationChainName);
  appendKeyValue(resultBody, 'Port / channel', `${route.portId}/${route.channelId}`);
  if (route.counterpartyChannelId) {
    appendKeyValue(
      resultBody,
      'Counterparty channel',
      `${route.counterpartyPortId}/${route.counterpartyChannelId}`
    );
  }
  appendKeyValue(resultBody, 'Route source', route.source);
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

function renderSupplyComparisons(rows: SupplyComparisonRow[], totalBalances: number): void {
  clearNode(comparisonBody);
  comparisonTitle.textContent = `Destination Supply (${rows.length})`;

  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No escrow balances available for comparison';
    comparisonBody.append(empty);
    comparisonPanel.hidden = false;
    return;
  }

  const header = document.createElement('div');
  header.className = 'comparison-row comparison-head';
  for (const label of ['Escrow', 'Denom', 'Supply', 'Delta']) {
    const cell = document.createElement('span');
    cell.textContent = label;
    header.append(cell);
  }
  comparisonBody.append(header);

  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'comparison-row';

    const sourceAmount = document.createElement('span');
    sourceAmount.className = 'comparison-amount';
    sourceAmount.textContent = row.amount;

    const denom = document.createElement('span');
    denom.className = 'comparison-denom';
    denom.textContent = row.destinationDenom
      ? `${row.denom} -> ${row.destinationDenom}`
      : row.denom;

    const destinationSupply = document.createElement('span');
    destinationSupply.className = row.error ? 'comparison-error' : 'comparison-amount';
    destinationSupply.textContent = row.error || row.destinationSupply;

    const delta = document.createElement('span');
    delta.className = row.delta === '0' ? 'comparison-ok' : 'comparison-delta';
    delta.textContent = row.error ? '-' : row.delta;

    item.append(sourceAmount, denom, destinationSupply, delta);
    comparisonBody.append(item);
  }

  if (totalBalances > rows.length) {
    const capped = document.createElement('p');
    capped.className = 'empty-state';
    capped.textContent = `${totalBalances - rows.length} additional balances not compared`;
    comparisonBody.append(capped);
  }

  comparisonPanel.hidden = false;
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

function subtractAmounts(left: string, right: string): string {
  try {
    return (BigInt(left) - BigInt(right)).toString();
  } catch {
    return '';
  }
}

async function fetchSupplyComparisons(
  options: LookupUrlOptions,
  route: ResolvedLookupRoute,
  balances: BalanceRow[],
  requests: Array<{ label: string; url: string }>
): Promise<SupplyComparisonRow[]> {
  const comparableBalances = balances
    .filter((balance) => balance.amount !== '0')
    .slice(0, MAX_SUPPLY_COMPARISONS);
  const rows: SupplyComparisonRow[] = [];

  for (const [index, balance] of comparableBalances.entries()) {
    try {
      const destinationDenom = await buildDestinationIbcDenom(route, balance.denom);
      const supplyRequest = buildLookupUrl(options, buildSupplyByDenomPath(destinationDenom));
      requests.push({
        label: `supply ${index + 1}`,
        url: supplyRequest.url,
      });
      const supplyData = (await fetchJson(supplyRequest.url)) as SupplyResponse;
      const destinationSupply = normalizeSupplyAmount(supplyData);
      rows.push({
        denom: balance.denom,
        amount: balance.amount,
        destinationDenom,
        destinationSupply,
        delta: subtractAmounts(balance.amount, destinationSupply),
      });
    } catch (error) {
      rows.push({
        denom: balance.denom,
        amount: balance.amount,
        destinationDenom: '',
        destinationSupply: '0',
        delta: '',
        error: error instanceof Error ? error.message : 'Supply lookup failed',
      });
    }
  }

  return rows;
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
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') as Array<
      HistoryEntry & {
        chainName?: string;
      }
    >;
    return Array.isArray(parsed)
      ? parsed
          .map((item) => ({
            ...item,
            sourceChainName: item.sourceChainName || item.chainName || '',
            destinationChainName: item.destinationChainName || '',
          }))
          .filter((item) => item.sourceChainName && item.channelId)
          .slice(0, 6)
      : [];
  } catch {
    return [];
  }
}

function saveHistory(entry: HistoryEntry): void {
  const history = loadHistory().filter(
    (item) =>
      !(
        item.sourceChainName === entry.sourceChainName &&
        item.destinationChainName === entry.destinationChainName &&
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
    button.textContent = `${item.sourceChainName} -> ${item.destinationChainName || '?'} ${item.channelId}`;
    button.addEventListener('click', () => {
      sourceChainInput.value = item.sourceChainName;
      if (item.destinationChainName) {
        destinationChainInput.value = item.destinationChainName;
      }
      channelInput.value = item.channelId;
      portInput.value = item.portId;
      updateEndpointFields();
      setStatus(`Loaded ${item.sourceChainName} ${item.channelId}`, 'idle');
    });
    historyBody.append(button);
  }
}

async function resolveRouteForLookup(
  settings: AppSettings,
  requests: Array<{ label: string; url: string }>
): Promise<ResolvedLookupRoute> {
  if (settings.channelId.trim()) {
    return resolveLookupRoute({
      sourceChainName: settings.sourceChainName,
      destinationChainName: settings.destinationChainName,
      channelId: settings.channelId,
      portId: settings.portId,
    });
  }

  const query = new URLSearchParams({
    source: settings.sourceChainName,
    destination: settings.destinationChainName,
  });
  const url = buildServiceUrl(`/api/ibc-links?${query.toString()}`);
  requests.push({ label: 'ibc links', url });
  const response = (await fetchJson(url)) as IbcLinksResponse;

  return resolveLookupRoute(
    {
      sourceChainName: settings.sourceChainName,
      destinationChainName: settings.destinationChainName,
      channelId: settings.channelId,
      portId: settings.portId,
    },
    response
  );
}

async function runLookup(settings: AppSettings): Promise<void> {
  const requests: Array<{ label: string; url: string }> = [];

  setStatus('Resolving route', 'busy');
  const route = await resolveRouteForLookup(settings, requests);
  const sourceOptions = buildLookupOptions(settings, route.sourceChainName, 'source');
  const destinationOptions = buildLookupOptions(
    settings,
    route.destinationChainName,
    'destination'
  );

  setStatus('Querying escrow address', 'busy');
  const escrowPath = buildEscrowAddressPath(route.channelId, route.portId);
  const escrowRequest = buildLookupUrl(sourceOptions, escrowPath);
  requests.push({ label: 'escrow', url: escrowRequest.url });
  const escrowData = (await fetchJson(escrowRequest.url)) as EscrowAddressResponse;

  if (!escrowData.escrow_address) {
    throw new Error('Escrow address was not returned');
  }

  renderEscrowResult(route, escrowData.escrow_address, escrowRequest.source);
  saveHistory({
    sourceChainName: route.sourceChainName,
    destinationChainName: route.destinationChainName,
    channelId: route.channelId,
    portId: route.portId,
    escrowAddress: escrowData.escrow_address,
    source: escrowRequest.source,
    timestamp: Date.now(),
  });
  renderHistory();

  setStatus('Querying escrow balances', 'busy');
  const balances = await fetchAllBalances(sourceOptions, escrowData.escrow_address, requests);
  renderBalances(balances);

  setStatus('Comparing destination supply', 'busy');
  const comparisons = await fetchSupplyComparisons(destinationOptions, route, balances, requests);
  renderSupplyComparisons(comparisons, balances.filter((balance) => balance.amount !== '0').length);

  if (settings.includeDetails) {
    setStatus('Querying channel details', 'busy');
    const channelRequest = buildLookupUrl(
      sourceOptions,
      buildChannelPath(route.channelId, route.portId)
    );
    requests.push({ label: 'channel', url: channelRequest.url });
    const channelData = (await fetchJson(channelRequest.url)) as ChannelResponse;
    const connectionId = extractConnectionId(channelData);

    const connectionRequest = buildLookupUrl(sourceOptions, buildConnectionPath(connectionId));
    requests.push({ label: 'connection', url: connectionRequest.url });
    const connectionData = (await fetchJson(connectionRequest.url)) as ConnectionResponse;
    const clientId = extractClientId(connectionData);

    const clientRequest = buildLookupUrl(sourceOptions, buildClientStatePath(clientId));
    requests.push({ label: 'client', url: clientRequest.url });
    const clientStateData = (await fetchJson(clientRequest.url)) as ClientStateResponse;

    renderChannelDetails(buildChannelDetails(channelData, connectionData, clientStateData));
  } else {
    clearNode(detailBody);
    detailPanel.hidden = true;
  }

  renderTrace(requests);
  setStatus('Lookup complete', 'ok');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (lookupDisabledForChains) {
    setChainMetadataState('loading');
    return;
  }

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
  clearNode(comparisonBody);
  comparisonTitle.textContent = 'Destination Supply';
  clearNode(detailBody);
  clearNode(traceBody);
  resultPanel.hidden = true;
  balancesPanel.hidden = true;
  comparisonPanel.hidden = true;
  detailPanel.hidden = true;
  tracePanel.hidden = true;
  setStatus('Ready', 'idle');
});

endpointModeInput.addEventListener('change', updateEndpointFields);
sourceChainInput.addEventListener('change', updateEndpointFields);
destinationChainInput.addEventListener('change', updateEndpointFields);

const initialSettings = loadSettings();
renderChainLoadingOptions(initialSettings);
applySettings(initialSettings);
void loadChainSummaries();
renderHistory();
