import { FormEvent, useEffect, useState } from 'react';
import { api } from './lib/api';
import { BrainCircuit, Check, Clock3, FileText, LockKeyhole, Plus, RefreshCw, ShieldCheck, Sparkles, X, PlayCircle } from 'lucide-react';

type User = { userId: string; email?: string; name?: string };
type Preparation = { runId: string; status: 'queued' | 'running' | 'prepared' | 'preparation_failed' | 'cancelled'; startedAt: string; finishedAt: string; objective?: string; checklist?: string[]; deliverable?: string; risks?: string[]; error?: string };
type GoalTask = { id: string; title: string; detail: string; successCriteria: string; status: 'awaiting_approval' | 'approved' | 'rejected' | 'queued' | 'preparing' | 'prepared' | 'preparation_failed' | 'cancelled'; preparation?: Preparation };
type Goal = { id: string; title: string; context: string; summary: string; tasks: GoalTask[]; createdAt: string };
type Props = { user: User | null; onSignIn: () => void };

export default function AutonomyCenter({ user, onSignIn }: Props) {
  const [title, setTitle] = useState('');
  const [context, setContext] = useState('');
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [busyTask, setBusyTask] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function loadGoals() {
    if (!user) return;
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/api/autonomy/goals');
      setGoals(Array.isArray(response.data?.goals) ? response.data.goals : []);
    } catch {
      setError('Your saved goals could not be loaded. Please refresh and try again.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (user) void loadGoals(); else setGoals([]); }, [user?.userId]);

  async function createPlan(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || planning) return;
    setPlanning(true); setError(''); setNotice('');
    try {
      const response = await api.post('/api/autonomy/plan', { title: title.trim(), context: context.trim() });
      const goal = response.data?.goal as Goal | undefined;
      if (!goal?.id || !Array.isArray(goal.tasks)) throw new Error('The planner did not return a saved goal.');
      setGoals(current => [goal, ...current]); setTitle(''); setContext('');
      setNotice('Your plan is saved. Review each task and approve only the work you want DAVImth to prepare.');
    } catch (err) {
      const failure = err as { response?: { data?: { error?: string } }; message?: string };
      setError(failure.response?.data?.error || failure.message || 'DAVImth could not create this plan. Please try again.');
    } finally { setPlanning(false); }
  }

  async function decide(goal: Goal, task: GoalTask, status: 'approved' | 'rejected') {
    const key = goal.id + ':' + task.id; setBusyTask(key); setError(''); setNotice('');
    try {
      await api.put('/api/autonomy/goals/' + encodeURIComponent(goal.id) + '/tasks/' + encodeURIComponent(task.id), { status });
      await loadGoals();
      setNotice(status === 'approved' ? 'Task approved. You can now add it to the cloud queue.' : 'Task rejected. DAVImth will not prepare it.');
    } catch (err) {
      const failure = err as { response?: { data?: { error?: string } } };
      setError(failure.response?.data?.error || 'Your decision could not be saved.');
    } finally { setBusyTask(''); }
  }

  async function queueTask(goal: Goal, task: GoalTask) {
    const key = goal.id + ':' + task.id; setBusyTask(key); setError(''); setNotice('');
    try {
      const response = await api.post('/api/autonomy/goals/' + encodeURIComponent(goal.id) + '/tasks/' + encodeURIComponent(task.id) + '/queue', {});
      await loadGoals(); setNotice(response.data?.message || 'Task added to the cloud queue.');
    } catch (err) {
      const failure = err as { response?: { data?: { error?: string } } };
      setError(failure.response?.data?.error || 'The task could not be queued.'); await loadGoals();
    } finally { setBusyTask(''); }
  }

  async function cancelTask(goal: Goal, task: GoalTask) {
    const key = goal.id + ':' + task.id; setBusyTask(key); setError(''); setNotice('');
    try {
      const response = await api.post('/api/autonomy/goals/' + encodeURIComponent(goal.id) + '/tasks/' + encodeURIComponent(task.id) + '/cancel', {});
      await loadGoals(); setNotice(response.data?.message || 'Background run cancelled.');
    } catch (err) {
      const failure = err as { response?: { data?: { error?: string } } };
      setError(failure.response?.data?.error || 'The background run could not be cancelled.');
    } finally { setBusyTask(''); }
  }

  if (!user) return <section className="studio-page autonomy-page">
    <div className="studio-heading"><div className="studio-icon"><BrainCircuit size={22} /></div><div><div className="eyebrow">DAVIMTH AUTONOMY ENGINE</div><h1>Autonomous Intelligence</h1><p>Give DAVImth a goal. It will plan the work and keep it under your control.</p></div></div>
    <div className="business-panel autonomy-signin"><LockKeyhole size={28} /><h2>Your private AI command centre</h2><p>Sign in to create goals, save plans and control task approvals securely.</p><button className="primary-action" type="button" onClick={onSignIn}>Sign in to continue</button></div>
  </section>;

  return <section className="studio-page autonomy-page">
    <div className="studio-heading"><div className="studio-icon"><BrainCircuit size={22} /></div><div><div className="eyebrow">DAVIMTH AUTONOMY ENGINE · PHASE 2B</div><h1>Autonomous Intelligence</h1><p>Plan goals, approve tasks and queue bounded cloud preparation runs.</p></div></div>
    <div className="autonomy-safety-card"><div className="autonomy-safety-icon"><ShieldCheck size={21} /></div><div><strong>Approval-gated cloud queue</strong><p>Approved tasks enter a persisted cloud queue. A scheduled worker prepares internal checklists and deliverable outlines. It does not browse the web, run arbitrary code, contact people, publish, spend money or change external accounts.</p></div><span className="autonomy-mode-tag">INTERNAL ONLY</span></div>
    <div className="business-panel autonomy-plan-panel">
      <div className="panel-heading"><h2><Sparkles size={18} /> Give DAVImth a goal</h2><span>AI goal planner</span></div>
      <form className="autonomy-form" onSubmit={createPlan}>
        <label htmlFor="autonomy-goal-title">What do you want DAVImth to achieve?</label>
        <input id="autonomy-goal-title" value={title} onChange={event => setTitle(event.target.value)} placeholder="Example: Build a customer-support website for my business" maxLength={140} required />
        <label htmlFor="autonomy-goal-context">Extra details and boundaries (optional)</label>
        <textarea id="autonomy-goal-context" value={context} onChange={event => setContext(event.target.value)} rows={4} maxLength={1800} placeholder="Describe the result you want, available tools, deadlines, budget limits or anything DAVImth must not do..." />
        <button className="primary-action" type="submit" disabled={planning || !title.trim()}>{planning ? <><span className="spinner" /> Building your plan...</> : <><Plus size={16} /> Create goal plan</>}</button>
        <p className="autonomy-footnote">Plans are AI-generated and should be reviewed. Background preparation is scheduled and limited to internal planning output.</p>
      </form>
    </div>
    <div className="autonomy-list-heading"><div><h2>Your saved goals</h2><p>{goals.length} {goals.length === 1 ? 'goal' : 'goals'} in your private workspace</p></div><button type="button" className="refresh-button" onClick={() => void loadGoals()} disabled={loading}><RefreshCw size={15} /> Refresh</button></div>
    {loading && <p className="empty-state">Loading your saved goals...</p>}
    {!loading && goals.length === 0 && <div className="business-panel autonomy-empty"><BrainCircuit size={25} /><h3>Your first autonomous goal starts here</h3><p>Describe something you want to achieve. DAVImth will create a practical, reviewable task plan.</p></div>}
    <div className="autonomy-goal-list">{goals.map(goal => {
      const pending = goal.tasks.filter(task => task.status === 'awaiting_approval').length;
      return <article className="business-panel autonomy-goal-card" key={goal.id}>
        <div className="autonomy-goal-heading"><div><span className="plan-label">GOAL · {new Date(goal.createdAt).toLocaleDateString()}</span><h3>{goal.title}</h3></div><span className="autonomy-pending-tag">{pending} awaiting approval</span></div>
        <p className="autonomy-summary">{goal.summary}</p>
        <div className="autonomy-task-list">{goal.tasks.map((task,index) => {
          const key = goal.id + ':' + task.id; const busy = busyTask === key;
          const statusLabel = task.status === 'awaiting_approval' ? 'Needs review' : task.status === 'approved' ? 'Approved' : task.status === 'rejected' ? 'Rejected' : task.status === 'queued' ? 'Queued' : task.status === 'preparing' ? 'Preparing' : task.status === 'prepared' ? 'Prepared' : task.status === 'cancelled' ? 'Cancelled' : 'Preparation failed';
          return <div className="autonomy-task" key={task.id}>
            <div className="autonomy-task-number">{index + 1}</div>
            <div className="autonomy-task-copy"><strong>{task.title}</strong><p>{task.detail}</p><small>Success: {task.successCriteria}</small>
              {task.preparation && <div className="autonomy-preparation">
                <div className="autonomy-preparation-heading"><FileText size={15} /><strong>Internal work package</strong><span>{task.preparation.status === 'queued' ? 'Queued' : task.preparation.status === 'running' ? 'Preparing' : task.preparation.status === 'prepared' ? 'Ready' : task.preparation.status === 'cancelled' ? 'Cancelled' : 'Needs retry'}</span></div>
                {task.preparation.objective && <p>{task.preparation.objective}</p>}
                {task.preparation.checklist && <ol>{task.preparation.checklist.map((item,itemIndex) => <li key={itemIndex}>{item}</li>)}</ol>}
                {task.preparation.deliverable && <p><b>Expected deliverable:</b> {task.preparation.deliverable}</p>}
                {task.preparation.risks?.length ? <p><b>Risks to review:</b> {task.preparation.risks.join(' · ')}</p> : null}
                {task.preparation.error && <p className="autonomy-preparation-error">{task.preparation.error}</p>}
              </div>}
            </div>
            <div className="autonomy-task-actions">
              <span className={'autonomy-task-status ' + task.status}>{statusLabel}</span>
              {task.status === 'awaiting_approval' && <div className="autonomy-decision-buttons"><button type="button" onClick={() => void decide(goal,task,'approved')} disabled={busy}><Check size={14} /> Approve</button><button type="button" onClick={() => void decide(goal,task,'rejected')} disabled={busy}><X size={14} /> Reject</button></div>}
              {(task.status === 'approved' || task.status === 'preparation_failed') && <button type="button" className="autonomy-prepare-button" onClick={() => void queueTask(goal,task)} disabled={busy}>{busy ? 'Queueing...' : <><PlayCircle size={14} /> {task.status === 'preparation_failed' ? 'Retry in cloud queue' : 'Queue task'}</>}</button>}
              {(task.status === 'queued' || task.status === 'preparing') && <button type="button" className="autonomy-prepare-button" onClick={() => void cancelTask(goal,task)} disabled={busy}>{busy ? 'Stopping...' : 'Cancel run'}</button>}
            </div>
          </div>;
        })}</div>
      </article>;
    })}</div>
    {notice && <div className="automation-note"><Check size={17} /><div><strong>Autonomous Intelligence</strong><p>{notice}</p></div></div>}
    {error && <div className="error-message" role="alert">{error}</div>}
    <div className="autonomy-next-step"><Clock3 size={17} /><div><strong>Next engine stage</strong><p>Background runs are queued and processed by a scheduled cloud worker. Next we will add scoped capability grants, richer progress events and safe project memory. External tools remain disabled until separately permissioned.</p></div></div>
  </section>;
}
