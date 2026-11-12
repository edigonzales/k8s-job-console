import {
  Alert, Box, Button, Checkbox, Chip, CircularProgress, FormControlLabel, LinearProgress, MenuItem,
  Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import {
  registerHomeSidebarEntryFilter, registerRoute, registerRouteFilter, registerSidebarEntry, registerSidebarEntryFilter,
} from '@kinvolk/headlamp-plugin/lib';
import React, { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Link, useHistory, useParams } from 'react-router-dom';
import { api, prefix, type ResultFile, type Account, type Job, type JobDetail, launch, type Parameter, type Run, type Schedule, type Value } from './api';

const root = '/job-console';
const statuses = ['Pending', 'Queued', 'Running', 'AwaitingInput', 'Canceling', 'Succeeded', 'Failed', 'Canceled', 'Rejected'] as const;
const date = (value?: string) => value ? new Date(value).toLocaleString('de-CH') : '–';
const active = (run: Run) => ['Pending', 'Queued', 'Running', 'AwaitingInput', 'Canceling'].includes(run.status);
const jobLink = (id: string) => root + '/jobs/' + id;
const runLink = (name: string) => root + '/runs/' + name;

function useApi<T>(path: string, interval?: number) {
  const [state, setState] = useState<{ path: string; data?: T; error?: string }>({ path });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const data = await api<T>(path, { signal: controller.signal });
        if (!controller.signal.aborted) setState({ path, data });
      } catch (error) {
        if (!controller.signal.aborted) setState(previous => ({
          path, data: previous.path === path ? previous.data : undefined, error: (error as Error).message,
        }));
      } finally {
        if (interval && !controller.signal.aborted) timer = setTimeout(load, interval);
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, interval, revision]);
  return { ...(state.path === path ? state : { data: undefined, error: undefined }),
    refresh: () => setRevision(v => v + 1) };
}

function Load<T>({ state, children }: { state: ReturnType<typeof useApi<T>>; children: (value: T) => ReactNode }) {
  return <>
    {state.error && <Alert severity="error" action={<Button onClick={state.refresh}>Erneut laden</Button>}>{state.error}</Alert>}
    {state.data === undefined ? !state.error && <CircularProgress size={24} aria-label="Lädt" /> : children(state.data)}
  </>;
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  const account = useApi<Account>('/me');
  return <Stack spacing={2} sx={{ p: { xs: 2, md: 3 }, mx: 'auto', maxWidth: 1250 }}>
    <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
      <Typography variant="h4" component="h1">{title}</Typography>
      {account.data && <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="body2">{account.data.displayName}</Typography>
        <Button href="/oauth2/sign_out?rd=/signed-out">Abmelden</Button>
      </Stack>}
    </Stack>
    {children}
  </Stack>;
}

function Rows({ headers, rows, empty }: { headers: string[]; rows: { key: string; cells: ReactNode[] }[]; empty: string }) {
  if (!rows.length) return <Typography color="text.secondary">{empty}</Typography>;
  return <TableContainer component={Paper} variant="outlined"><Table>
    <TableHead><TableRow>{headers.map(header => <TableCell key={header}>{header}</TableCell>)}</TableRow></TableHead>
    <TableBody>{rows.map(row => <TableRow key={row.key}>{row.cells.map((cell, index) =>
      <TableCell key={index}>{cell}</TableCell>)}</TableRow>)}</TableBody>
  </Table></TableContainer>;
}

function Status({ status }: { status: Run['status'] }) {
  const color = { Pending: 'default', Queued: 'default', Running: 'info', AwaitingInput: 'warning',
    Canceling: 'warning', Succeeded: 'success', Failed: 'error', Canceled: 'warning', Rejected: 'error' } as const;
  return <Chip size="small" label={status} color={color[status]} />;
}

function Jobs() {
  const jobs = useApi<Job[]>('/jobs');
  const runs = useApi<Run[]>('/runs', 5000);
  return <Page title="Jobs"><Load state={jobs}>{data => <Rows
    headers={['Job', 'Runtime', 'Zeitplan', 'Letzte Ausführung', 'Aktion']}
    empty="Der Katalog enthält keine Jobs."
    rows={data.map(job => {
      const last = runs.data?.find(run => run.jobId === job.id);
      return { key: job.id, cells: [
        <><Typography component="div" fontWeight="medium">{job.name}</Typography>
          <Typography variant="body2" color="text.secondary">{job.description}</Typography></>,
        job.runtime,
        job.schedule ? <Link to={root + '/schedules'}>{job.schedule.cron}</Link> : '–',
        last ? <Link to={runLink(last.name)}><Status status={last.status} /></Link> : '–',
        <Button component={Link} to={jobLink(job.id)} variant="outlined"
          aria-label={job.name + (job.allowed.includes('run') ? ' starten' : ' Details')}>
          {job.allowed.includes('run') ? 'Starten' : 'Details'}
        </Button>,
      ] };
    })} />}</Load></Page>;
}

function Field({ field, value, file, onValue, onFile, error }: {
  field: Parameter; value?: Value; file?: File; error?: string;
  onValue: (value: Value) => void; onFile: (file?: File) => void;
}) {
  const errorId = useId();
  const label = field.label + (field.required && ['file', 'boolean'].includes(field.type) ? ' *' : '');
  if (field.type === 'boolean') return <FormControlLabel label={label}
    control={<Checkbox checked={value === true} onChange={event => onValue(event.target.checked)} />} />;
  if (field.type === 'file') return <Stack spacing={0.5}>
    <Button variant="outlined" component="label" tabIndex={-1} role={undefined} sx={{
      alignSelf: 'flex-start',
      '&:focus-within': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
    }}>
      {label}
      <input type="file" aria-label={label} accept={field.accept?.join(',')}
        required={field.required} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
        onChange={event => onFile(event.target.files?.[0])} />
    </Button>
    {file && <Typography variant="body2">{file.name} ({(file.size / 1024).toLocaleString('de-CH', { maximumFractionDigits: 1 })} KiB)</Typography>}
    {error && <Typography id={errorId} variant="caption" color="error">{error}</Typography>}
  </Stack>;
  return <TextField label={label} required={field.required} value={value ?? ''}
    select={field.type === 'enum'} multiline={field.type === 'multiline'}
    type={field.type === 'integer' ? 'number' : field.type === 'date' ? 'date' : 'text'}
    InputLabelProps={field.type === 'date' ? { shrink: true } : undefined}
    error={Boolean(error)} helperText={error}
    onChange={event => onValue(event.target.value)}>
    {field.options?.map(option => <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>)}
  </TextField>;
}

function JobForm({ job }: { job: JobDetail }) {
  const history = useHistory();
  const [values, setValues] = useState<Record<string, Value>>(() => Object.fromEntries(job.parameters
    .flatMap(p => p.default !== undefined ? [[p.name, p.default]] : p.type === 'boolean' ? [[p.name, false]] : [])));
  const [files, setFiles] = useState<Record<string, File | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const controller = useRef<AbortController>();
  const uploading = busy && Object.values(files).some(Boolean) && (progress ?? 0) < 100;
  useEffect(() => () => controller.current?.abort(), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (controller.current) return;
    const nextErrors: Record<string, string> = {};
    const typed: Record<string, Value> = {};
    const uploads: [string, File][] = [];
    for (const p of job.parameters) {
      const value = values[p.name];
      if (p.type === 'file') {
        const file = files[p.name];
        if (file) {
          const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
          if (!extension || !p.accept?.some(accepted => accepted.toLowerCase() === extension)) nextErrors[p.name] = 'Dateiendung nicht zulässig.';
          else if (file.size > 512 * 1024 ** 2) nextErrors[p.name] = 'Die Datei ist grösser als 512 MiB.';
          else uploads.push([p.name, file]);
        } else if (p.required) nextErrors[p.name] = 'Wähle eine Datei aus.';
        continue;
      }
      if (value === undefined || (value === '' && !['enum', 'text', 'multiline'].includes(p.type))) {
        if (p.required) nextErrors[p.name] = 'Gib einen Wert ein.';
        continue;
      }
      if (p.type === 'integer') {
        const number = Number(value);
        if (!Number.isInteger(number) || number < -2147483648 || number > 2147483647) nextErrors[p.name] = 'Gib eine gültige Ganzzahl ein.';
        else typed[p.name] = number;
      } else if (p.required && ['text', 'multiline'].includes(p.type) && !String(value).trim()) {
        nextErrors[p.name] = 'Gib einen Wert ein.';
      } else typed[p.name] = value;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setBusy(true);
    setError('');
    setProgress(uploads.length ? 0 : null);
    const attempt = new AbortController();
    controller.current = attempt;
    try {
      const run = await launch(job.id, job.source?.revision ?? '', typed, uploads.map(([, file]) => file), uploads.map(([field]) => field), setProgress, attempt.signal);
      history.push(runLink(run.name));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      controller.current = undefined;
      setBusy(false);
    }
  }

  return <Stack component="form" onSubmit={submit} noValidate spacing={2} sx={{ maxWidth: 580 }}>
    <Typography>{job.description}</Typography>
    {job.source?.revision && <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
      Git {job.source.ref && job.source.ref + ' · '}{job.source.revision}{job.preview && ' · Vorschau'}
    </Typography>}
    {job.schedule && <Typography color="text.secondary">{job.schedule.cron} · {job.schedule.timeZone}</Typography>}
    {error && <Alert severity="error">{error}</Alert>}
    <Box component="fieldset" disabled={busy} sx={{ border: 0, m: 0, p: 0, minWidth: 0 }}>
      <Stack spacing={2}>{job.parameters.map(p => <Field key={p.name} field={p} value={values[p.name]}
        file={files[p.name]} error={errors[p.name]}
        onValue={value => setValues(previous => ({ ...previous, [p.name]: value }))}
        onFile={file => {
          setFiles(previous => ({ ...previous, [p.name]: file }));
          setErrors(previous => ({ ...previous, [p.name]: '' }));
        }} />)}</Stack>
    </Box>
    {busy && <Stack spacing={1}>
      <Typography variant="body2">{uploading ? progress === null ? 'Upload läuft' : `Upload ${Math.floor(progress)} %` : 'Job wird gestartet'}</Typography>
      <LinearProgress aria-label="Startfortschritt" variant={progress === null || progress >= 100 ? 'indeterminate' : 'determinate'} value={progress ?? 0} />
    </Stack>}
    <Stack direction="row" spacing={1}>
      <Button variant="contained" type="submit" disabled={busy}>Job starten</Button>
      {uploading && <Button onClick={() => controller.current?.abort()}>Upload abbrechen</Button>}
    </Stack>
  </Stack>;
}

function JobDetails() {
  const { id } = useParams<{ id: string }>();
  const job = useApi<JobDetail>('/jobs/' + encodeURIComponent(id ?? ''));
  return <Page title={job.data?.name ?? 'Job'}><Load state={job}>{data => data.allowed.includes('run')
    ? <JobForm key={data.id} job={data} />
    : <Typography>{data.description}</Typography>}</Load></Page>;
}

function duration(run: Run) {
  if (!run.started) return '–';
  const seconds = Math.max(0, Math.floor(((run.finished ? Date.parse(run.finished) : Date.now()) - Date.parse(run.started)) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function Runs() {
  const runs = useApi<Run[]>('/runs', 3000);
  const jobs = useApi<Job[]>('/jobs');
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('');
  return <Page title="Ausführungen">
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
      <TextField select label="Job" value={filter} onChange={e => setFilter(e.target.value)} sx={{ minWidth: 180 }}
        InputLabelProps={{ shrink: true }} SelectProps={{ displayEmpty: true }}>
        <MenuItem value="">Alle Jobs</MenuItem>
        {[...new Set<string>(runs.data?.map(run => run.jobId))].sort().map(id =>
          <MenuItem value={id} key={id}>{jobs.data?.find(job => job.id === id)?.name ?? id}</MenuItem>)}
      </TextField>
      <TextField select label="Status" value={status} onChange={e => setStatus(e.target.value)} sx={{ minWidth: 150 }}
        InputLabelProps={{ shrink: true }} SelectProps={{ displayEmpty: true }}>
        <MenuItem value="">Alle Status</MenuItem>
        {statuses.map(value => <MenuItem value={value} key={value}>{value}</MenuItem>)}
      </TextField>
    </Stack>
    <Load state={runs}>{data => <Rows headers={['Job', 'Ausführung', 'Start', 'Status', 'Dauer']}
      empty="Keine passenden Ausführungen."
      rows={data.filter(run => (!filter || filter === run.jobId) && (!status || status === run.status)).map(run => ({
        key: run.name, cells: [jobs.data?.find(job => job.id === run.jobId)?.name ?? run.jobId,
          <Link to={runLink(run.name)}>{run.name}</Link>, date(run.started ?? run.created), <Status status={run.status} />, duration(run)],
      }))} />}</Load>
  </Page>;
}

function RunDetails() {
  const history = useHistory();
  const { name } = useParams<{ name: string }>();
  const path = '/runs/' + encodeURIComponent(name ?? '');
  const run = useApi<Run>(path, 3000);
  const logs = useApi<{ logs: string; message?: string }>(path + '/logs', 3000);
  const files = useApi<ResultFile[]>(path + '/artifacts', 3000);
  const job = useApi<JobDetail>('/jobs/' + encodeURIComponent(run.data?.jobId ?? ''));
  const jobs = useApi<Job[]>('/jobs');
  const account = useApi<Account>('/me');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function updateRun(action: 'cancel' | 'delete' | 'repeat') {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (action === 'cancel') {
        await api(path + '/cancel', { method: 'POST' });
        run.refresh();
      } else if (action === 'repeat') {
        const repeated = await api<Run>(path + '/rerun', { method: 'POST' });
        history.push(runLink(repeated.name));
      } else {
        await api(path, { method: 'DELETE' });
        history.push(root + '/runs');
      }
    }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  const jobName = jobs.data?.find(job => job.id === run.data?.jobId)?.name ?? run.data?.jobId;
  return <Page title={jobName ?? 'Ausführung'}><Load state={run}>{data => <>
    <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{data.name} · {date(data.started ?? data.created)}{data.starterName && ' · ' + data.starterName}</Typography>
    {data.revision && <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
      Git {data.revision} · {data.image} · {data.scheduled ? 'Zeitplan' : 'Manuell'}
    </Typography>}
    <Stack direction="row" spacing={1} alignItems="center">
      <Status status={data.status} />
      {data.reason && <Typography>{data.reason}</Typography>}
    </Stack>
    {error && <Alert severity="error">{error}</Alert>}
    <Stack direction="row" spacing={1}>
      <Button variant="outlined" onClick={() => { run.refresh(); logs.refresh(); files.refresh(); }}>Aktualisieren</Button>
      {active(data)
        ? (job.data?.allowed.includes('manage') || account.data?.admin ||
            (job.data?.allowed.includes('run') && data.starter === account.data?.id)) && <Button variant="outlined" color="warning" disabled={busy || data.status === 'Canceling'} onClick={() => updateRun('cancel')}>Abbrechen</Button>
        : <>
          {job.data?.allowed.includes('run') && <Button variant="outlined" disabled={busy} onClick={() => updateRun('repeat')}>Wiederholen</Button>}
          {job.data?.allowed.includes('run') && job.data.parameters.some(parameter => parameter.type === 'file') &&
            <Button component={Link} to={jobLink(data.jobId)} variant="outlined">Mit neuer Datei starten</Button>}
          {(job.data?.allowed.includes('manage') || account.data?.admin) && <Button variant="outlined" color="error" disabled={busy} onClick={() => updateRun('delete')}>Löschen</Button>}
        </>}
    </Stack>
    {Object.keys(data.parameters).length > 0 && <Box component="dl" sx={{ m: 0, overflowWrap: 'anywhere' }}>
      {Object.entries(data.parameters).map(([key, value]) => <React.Fragment key={key}>
        <Typography component="dt" fontWeight="medium">{key}</Typography>
        <Typography component="dd" sx={{ ml: 2, whiteSpace: 'pre-wrap' }}>{String(value)}</Typography>
      </React.Fragment>)}
    </Box>}
    <Load state={files}>{items => items.length > 0 && <>
      <Typography variant="h6" component="h2">Ergebnisdateien</Typography>
      <Rows headers={['Datei', 'Schritt', 'Grösse', 'Aktion']} empty="" rows={items.map(item => ({
        key: item.id, cells: [item.label + ' · ' + item.name, item.step,
          item.size === undefined ? '–' : `${item.size.toLocaleString('de-CH')} B`,
          item.available
            ? <Button href={prefix + path + '/artifacts/' + encodeURIComponent(item.id)}>Herunterladen</Button>
            : 'Nicht verfügbar'],
      }))} />
    </>}</Load>
    <Typography variant="h6" component="h2">Logs</Typography>
    <Load state={logs}>{result => result.logs ? <Paper component="pre" variant="outlined" tabIndex={0}
      sx={{ p: 2, m: 0, maxHeight: '55vh', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {result.logs}
    </Paper> : <Typography color="text.secondary">{result.message}</Typography>}</Load>
  </>}</Load></Page>;
}

function Schedules() {
  const state = useApi<Schedule[]>('/schedules', 5000);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function change(item: Schedule) {
    setError('');
    setBusy(item.id);
    try {
      await api('/schedules/' + encodeURIComponent(item.id) + (item.active ? '/pause' : '/resume'), { method: 'POST' });
      state.refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(''); }
  }
  return <Page title="Zeitpläne">{error && <Alert severity="error">{error}</Alert>}<Load state={state}>{data => <Rows
    headers={['Job', 'Cron', 'Aufgelöst', 'Zeitzone', 'Status', 'Letzter Start', 'Aktion']}
    empty="Keine geplanten Jobs."
    rows={data.map(item => ({ key: item.id, cells: [<Link to={jobLink(item.id)}>{item.name}</Link>,
      item.cron, item.resolvedCron, item.timeZone, item.active === null ? 'Nicht bereitgestellt' : item.active ? 'Aktiv' : 'Suspendiert',
      date(item.lastSchedule), item.canManage && item.active !== null &&
        <Button disabled={Boolean(busy)} onClick={() => change(item)}>{item.active ? 'Pausieren' : 'Aktivieren'}</Button>] }))} />}</Load></Page>;
}

interface SyncStatus {
  repository?: string;
  defaultRef: string;
  previewEnabled: boolean;
  active?: { ref?: string; revision: string };
  runs: (Run & { ref: string })[];
}

function Synchronizations() {
  const state = useApi<SyncStatus>('/synchronizations', 4000);
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const details = useApi<{ logs?: string }>(selected ? '/synchronizations/' + selected : '/healthz', selected ? 4000 : undefined);
  async function start(branch?: string) {
    setError('');
    setBusy(true);
    try {
      const run = await api<Run>('/synchronizations', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(branch ? { ref: branch } : {}) });
      setSelected(run.name);
      state.refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return <Page title="Bereitstellung"><Load state={state}>{data => <>
    <Typography>{data.repository}</Typography>
    {data.active && <Typography sx={{ overflowWrap: 'anywhere' }}>
      {data.active.ref} · {data.active.revision}
      {data.active.ref !== data.defaultRef && ' · Vorschau'}
    </Typography>}
    <Typography>Letzter erfolgreicher Sync {date(data.runs.find(run => run.status === 'Succeeded')?.finished)}</Typography>
    {error && <Alert severity="error">{error}</Alert>}
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
      <Button variant="contained" disabled={busy || data.runs.some(active)} onClick={() => start()}>Jetzt synchronisieren</Button>
      {data.previewEnabled && <>
        <TextField size="small" label="Vorschau-Branch" value={ref} onChange={event => setRef(event.target.value)} />
        <Button variant="outlined" disabled={busy || data.runs.some(active) || !ref.trim()} onClick={() => start(ref.trim())}>Vorschau laden</Button>
      </>}
    </Stack>
    <Rows headers={['Versuch', 'Branch', 'Revision', 'Status', 'Details']} empty="Keine Synchronisationen."
      rows={data.runs.map(run => ({ key: run.name, cells: [
        date(run.started ?? run.created), run.ref, run.revision ?? '–', <Status status={run.status} />,
        <Button onClick={() => setSelected(run.name)}>Protokoll</Button>,
      ] }))} />
    {selected && <Load state={details}>{result => result.logs &&
      <Paper component="pre" sx={{ p: 2, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result.logs}</Paper>
    }</Load>}
  </>}</Load></Page>;
}

const sidebar = 'HOME';
const pages = [
  { name: 'jobs', label: 'Jobs', path: root, icon: 'mdi:format-list-bulleted', component: Jobs },
  { name: 'runs', label: 'Ausführungen', path: root + '/runs', icon: 'mdi:play-circle-outline', component: Runs },
  { name: 'deployment', label: 'Bereitstellung', path: root + '/deployment', icon: 'mdi:source-branch-sync', component: Synchronizations },
  { name: 'schedules', label: 'Zeitpläne', path: root + '/schedules', icon: 'mdi:calendar-clock', component: Schedules },
];
for (const page of pages) {
  const name = 'job-console-' + page.name;
  const registerEntry = () => registerSidebarEntry({
    parent: null, name, label: page.label, url: page.path, icon: page.icon, useClusterURL: false, sidebar,
  });
  if (page.name === 'deployment') void api<Account>('/me').then(account => { if (account.admin) registerEntry(); }).catch(() => {});
  else registerEntry();
  registerRoute({ path: page.path, name, component: page.component, exact: true,
    useClusterURL: false, noAuthRequired: true, sidebar: { item: name, sidebar } });
}
for (const [path, item, component] of [
  ['/', 'jobs', Jobs], [root + '/jobs/:id', 'jobs', JobDetails], [root + '/runs/:name', 'runs', RunDetails],
] as const) {
  registerRoute({ path, name: 'job-console-' + path, component, exact: true, useClusterURL: false,
    noAuthRequired: true, sidebar: { item: 'job-console-' + item, sidebar } });
}
registerSidebarEntryFilter(() => null);
registerHomeSidebarEntryFilter(entry => entry.name.startsWith('job-console-') || entry.name === 'settings' ? entry : null);
registerRouteFilter(route => route.name?.startsWith('job-console-') || (route.path.startsWith('/settings') || route.path === '*') ? route : null);
