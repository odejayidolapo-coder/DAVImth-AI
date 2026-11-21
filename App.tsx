import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import AutonomyCenter from './AutonomyCenter';
import { api, auth, image } from '@appdeploy/client';
import * as pdfjsLib from 'pdfjs-dist';
import * as mammoth from 'mammoth';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
import {
  ArrowUp, Bot, BrainCircuit, Check, ImagePlus, Menu, MessageSquare,
  Plus, Sparkles, Video, X, Download, BriefcaseBusiness, ClipboardList,
  CircleCheck, Clock3, LogIn, LogOut, RefreshCw, Building2, Paperclip,
  Camera, Mic, MicOff, FileText, Image as ImageIcon, Share2, CalendarDays,
  Copy, CheckCircle2, Link2, GraduationCap, BookOpen, Headphones, Upload, LockKeyhole,
} from 'lucide-react';

type Message = { role: 'user' | 'assistant'; content: string };
type StudySession = { id: string; subject: string; level: string; topic: string; messages: Message[]; completed: boolean; quizAttempts: number; bestQuizPercent: number; createdAt: string; updatedAt: string };
function createStudySessionId() { return 'study-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
type SpeechRecognitionResultLike = { isFinal: boolean; 0: { transcript: string } };
type SpeechRecognitionEventLike = { resultIndex: number; results: ArrayLike<SpeechRecognitionResultLike> };
type SpeechRecognitionLike = {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null; onend: (() => void) | null;
  start: () => void; stop: () => void;
};
type Conversation = { id: string; title: string; messages: Message[]; updatedAt: number };
const CHAT_KEY = 'davimth-conversations-v1';
type StudioTab = 'chat' | 'image' | 'video' | 'business' | 'social' | 'support' | 'study' | 'autonomy';
type SocialMode = 'manual' | 'approval';
type SocialDraft = { id: string; platform: string; content: string; mode: SocialMode; schedule: string; status: 'Draft' | 'Awaiting approval' | 'Approved'; createdAt: number; mediaName?: string; mediaType?: string; mediaSize?: number };
const SOCIAL_DRAFTS_KEY = 'davimth-social-drafts-v1';
const SOCIAL_MEDIA_DB = 'davimth-social-media-v1';
function openSocialMediaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SOCIAL_MEDIA_DB, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('media')) request.result.createObjectStore('media', { keyPath: 'id' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open media storage'));
  });
}
async function saveSocialMedia(id: string, file: File) {
  const db = await openSocialMediaDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('media', 'readwrite');
    transaction.objectStore('media').put({ id, blob: file });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not save media'));
    transaction.onabort = () => reject(transaction.error || new Error('Media save was cancelled'));
  });
  db.close();
}
async function readSocialMedia(id: string): Promise<Blob | null> {
  const db = await openSocialMediaDb();
  const result = await new Promise<Blob | null>((resolve, reject) => {
    const request = db.transaction('media', 'readonly').objectStore('media').get(id);
    request.onsuccess = () => resolve(request.result?.blob || null);
    request.onerror = () => reject(request.error || new Error('Could not read media'));
  });
  db.close();
  return result;
}
const socialPlatforms = ['Facebook', 'Instagram', 'TikTok', 'WhatsApp Business', 'YouTube', 'LinkedIn', 'X', 'Pinterest'];
function readSocialDrafts(): SocialDraft[] {
  try {
    const saved = JSON.parse(localStorage.getItem(SOCIAL_DRAFTS_KEY) || '[]');
    return Array.isArray(saved) ? saved.filter(item => item && typeof item.id === 'string' && typeof item.content === 'string') : [];
  } catch { return []; }
}
type WorkspaceRecord = {
  id: string;
  kind: 'business' | 'task';
  title: string;
  detail: string;
  businessName: string;
  status: string;
  createdAt: string;
};
type User = { userId: string; email?: string; name?: string };
type SupportAssistant = { id: string; businessName: string; description: string; knowledge: string; createdAt?: string; updatedAt?: string };
type SupportConversation = { id: string; assistantId: string; messages: Array<{ role: 'customer' | 'assistant'; content: string }>; status: 'open' | 'needs_human' | 'resolved'; createdAt?: string; updatedAt?: string };

const USAGE_KEY = 'davimth-free-image-usage';
function todayKey() { return new Date().toISOString().slice(0, 10); }
function readImageUsage(storageKey = USAGE_KEY) {
  try {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return { date: todayKey(), count: 0 };
    const parsed = JSON.parse(saved) as { date?: string; count?: number };
    if (parsed.date !== todayKey()) return { date: todayKey(), count: 0 };
    return { date: todayKey(), count: Math.max(0, Number(parsed.count) || 0) };
  } catch { return { date: todayKey(), count: 0 }; }
}
const starterPrompts = [
  'Explain artificial intelligence in simple terms',
  'Help me plan a small online business',
  'Teach me a beginner-friendly Python concept',
];


type StudyBuddyProps = { user: User | null; authLoading: boolean; authError: string; onSignIn: () => void };
function StudyBuddy({ user, authLoading, authError, onSignIn }: StudyBuddyProps) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [accessLoading, setAccessLoading] = useState(false);
  const [subject, setSubject] = useState('Computer Science');
  const [level, setLevel] = useState('Beginner');
  const [topic, setTopic] = useState('Introduction');
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [studySessions, setStudySessions] = useState<StudySession[]>([]);
  const [studySessionsLoading, setStudySessionsLoading] = useState(false);
  const [studySaving, setStudySaving] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState(createStudySessionId);
  const [lessonCompleted, setLessonCompleted] = useState(false);
  const [sessionQuizAttempts, setSessionQuizAttempts] = useState(0);
  const [sessionBestQuizPercent, setSessionBestQuizPercent] = useState(0);
  const [quizScore, setQuizScore] = useState('');
  const [quizTotal, setQuizTotal] = useState('10');
  const [studySummary, setStudySummary] = useState({ completedLessons: 0, quizAttempts: 0, bestQuizPercent: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [voiceMode, setVoiceMode] = useState(false);
  const [listening, setListening] = useState(false);
  const [classroomOpen, setClassroomOpen] = useState(false);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState('');
  const [speechLanguage, setSpeechLanguage] = useState('en-NG');
  const [speechRate, setSpeechRate] = useState(0.95);
  const [teacherStyle, setTeacherStyle] = useState('A warm African woman teacher');
  const [teacherImage, setTeacherImage] = useState('');
  const [teacherImageBusy, setTeacherImageBusy] = useState(false);
  const [lessonGraphic, setLessonGraphic] = useState('');
  const [graphicBusy, setGraphicBusy] = useState(false);
  const voiceModeRef = useRef(false);
  const speechRef = useRef<SpeechRecognitionLike | null>(null);
  const videoPreviews = useMemo(() => files.filter(file => file.type.startsWith('video/')).map(file => ({ name: file.name, url: URL.createObjectURL(file) })), [files]);

  useEffect(() => () => { videoPreviews.forEach(item => URL.revokeObjectURL(item.url)); }, [videoPreviews]);

  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const refreshVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      setAvailableVoices(voices);
      setSelectedVoice(current => current || voices.find(voice => voice.lang === 'en-NG')?.voiceURI || voices.find(voice => voice.lang.startsWith('en'))?.voiceURI || voices[0]?.voiceURI || '');
    };
    refreshVoices();
    window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', refreshVoices);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!user) { setIsAdmin(false); return; }
    setAccessLoading(true);
    api.get('/api/study/access').then(response => {
      if (!cancelled) setIsAdmin(response.data?.isAdmin === true);
    }).catch(() => {
      if (!cancelled) setError('Your study access could not be checked. Please refresh and try again.');
    }).finally(() => { if (!cancelled) setAccessLoading(false); });
    return () => { cancelled = true; };
  }, [user?.userId]);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setStudySessions([]);
      setStudySummary({ completedLessons: 0, quizAttempts: 0, bestQuizPercent: 0 });
      return;
    }
    setStudySessionsLoading(true);
    api.get('/api/study/sessions').then(response => {
      if (cancelled) return;
      const saved = Array.isArray(response.data?.sessions) ? response.data.sessions as StudySession[] : [];
      setStudySessions(saved);
      const summary = response.data?.summary || {};
      setStudySummary({
        completedLessons: Number(summary.completedLessons) || 0,
        quizAttempts: Number(summary.quizAttempts) || 0,
        bestQuizPercent: Number(summary.bestQuizPercent) || 0,
      });
    }).catch(() => {
      if (!cancelled) setError('Saved lessons could not be loaded. You can still start a new lesson.');
    }).finally(() => { if (!cancelled) setStudySessionsLoading(false); });
    return () => { cancelled = true; };
  }, [user?.userId]);

  async function saveStudySession(nextMessages: Message[], options: { completed?: boolean; quizAttempts?: number; bestQuizPercent?: number; silent?: boolean } = {}) {
    if (!user) return;
    setStudySaving(true);
    const record = {
      sessionId: activeSessionId, subject, level, topic, messages: nextMessages.slice(-12),
      completed: options.completed ?? lessonCompleted,
      quizAttempts: options.quizAttempts ?? sessionQuizAttempts,
      bestQuizPercent: options.bestQuizPercent ?? sessionBestQuizPercent,
    };
    try {
      const response = await api.post('/api/study/sessions', record);
      const saved = response.data?.session as StudySession | undefined;
      if (saved) {
        setStudySessions(current => [saved, ...current.filter(item => item.id !== saved.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30));
        setStudySummary(current => ({
          completedLessons: Math.max(current.completedLessons, studySessions.filter(item => item.completed).length + (saved.completed && !studySessions.some(item => item.id === saved.id && item.completed) ? 1 : 0)),
          quizAttempts: Math.max(current.quizAttempts, studySessions.reduce((sum, item) => sum + item.quizAttempts, 0) + Math.max(0, saved.quizAttempts - (studySessions.find(item => item.id === saved.id)?.quizAttempts || 0))),
          bestQuizPercent: Math.max(current.bestQuizPercent, saved.bestQuizPercent),
        }));
      }
      if (!options.silent) setNotice('Your lesson has been saved to your account. You can continue it later.');
    } catch (err) {
      const failure = err as { response?: { data?: { error?: string } } };
      setError(failure.response?.data?.error || 'Your lesson could not be saved. Please try again.');
    } finally { setStudySaving(false); }
  }

  function openStudySession(sessionId: string) {
    const session = studySessions.find(item => item.id === sessionId);
    if (!session) return;
    setActiveSessionId(session.id);
    setSubject(session.subject);
    setLevel(session.level);
    setTopic(session.topic);
    setMessages(session.messages || []);
    setLessonCompleted(session.completed);
    setSessionQuizAttempts(session.quizAttempts || 0);
    setSessionBestQuizPercent(session.bestQuizPercent || 0);
    setQuizScore('');
    setError('');
    setNotice('Previous lesson opened. Continue learning from where you stopped.');
  }

  async function markLessonComplete() {
    if (!messages.length) { setError('Start a lesson before marking it complete.'); return; }
    setLessonCompleted(true);
    await saveStudySession(messages, { completed: true, silent: true });
    setNotice('Lesson completed and saved. Well done!');
  }

  async function recordQuizScore() {
    const score = Number(quizScore);
    const total = Number(quizTotal);
    if (!Number.isInteger(score) || !Number.isInteger(total) || total < 1 || total > 100 || score < 0 || score > total) {
      setError('Enter a valid quiz score: the score must be between zero and the total.');
      return;
    }
    const attempts = sessionQuizAttempts + 1;
    const best = Math.max(sessionBestQuizPercent, Math.round((score / total) * 100));
    setSessionQuizAttempts(attempts);
    setSessionBestQuizPercent(best);
    await saveStudySession(messages, { quizAttempts: attempts, bestQuizPercent: best, silent: true });
    setQuizScore('');
    setNotice('Quiz result saved: ' + score + '/' + total + ' (' + Math.round((score / total) * 100) + '%).');
  }

  async function extractStudyVideoFrames(file: File, maxFrames: number): Promise<Array<{ data: string; mimeType: string; time: number }>> {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.src = objectUrl;
    try {
      await new Promise<void>((resolve, reject) => {
        video.addEventListener('loadedmetadata', () => resolve(), { once: true });
        video.addEventListener('error', () => reject(new Error('This video format could not be opened for analysis. Try MP4 or WebM.')), { once: true });
        video.load();
      });
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (!duration || !video.videoWidth || !video.videoHeight) throw new Error('The video has no readable frames. Try another video file.');
      const fractions = duration < 1.5 ? [0.5] : [0.05, 0.35, 0.65, 0.95];
      const times = fractions.slice(0, Math.max(1, maxFrames)).map(fraction => Math.max(0, Math.min(duration - 0.04, duration * fraction)));
      const frames: Array<{ data: string; mimeType: string; time: number }> = [];
      for (const time of times) {
        await new Promise<void>((resolve, reject) => {
          video.addEventListener('seeked', () => resolve(), { once: true });
          video.addEventListener('error', () => reject(new Error('A video frame could not be decoded.')), { once: true });
          video.currentTime = time;
        });
        const scale = Math.min(1, 1000 / video.videoWidth, 1000 / video.videoHeight);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Your browser could not prepare a video frame.');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('A video frame could not be compressed.')), 'image/jpeg', 0.72));
        const prepared = await image.resizeIfNeeded(blob, { maxDimension: 1000, maxPixels: 1000000, quality: 0.72, mimeType: 'image/jpeg' });
        frames.push({ data: prepared.data, mimeType: prepared.mimeType, time });
      }
      return frames;
    } finally {
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function extractStudyDocument(file: File): Promise<string> {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, 25); pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const textContent = await page.getTextContent();
        pages.push(textContent.items.map(item => 'str' in item ? item.str : '').join(' '));
      }
      const result = pages.join('\n\n').trim();
      if (!result) throw new Error('This PDF has no selectable text. Try a clear image of the page.');
      return result.slice(0, 10000);
    }
    if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\.docx$/i.test(file.name)) {
      const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      if (!result.value.trim()) throw new Error('No readable text was found in this Word document.');
      return result.value.slice(0, 10000);
    }
    return (await file.text()).slice(0, 10000);
  }

  async function fileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result || '');
        const comma = value.indexOf(',');
        if (comma < 0) reject(new Error('Could not read the attachment.'));
        else resolve(value.slice(comma + 1));
      };
      reader.onerror = () => reject(new Error('Could not read the attachment.'));
      reader.readAsDataURL(file);
    });
  }

  async function sendStudyMessage(text?: string) {
    const prompt = (text ?? input).trim();
    if ((!prompt && files.length === 0) || busy) return;
    if (!user) { setError('Sign in to use your personal Study Buddy.'); return; }
    const selected = files;
    let content = prompt;
    const images: Array<{ data: string; mimeType: string }> = [];
    const audios: Array<{ data: string; mimeType: string }> = [];
    try {
      for (const file of selected) {
        if (file.type.startsWith('image/')) {
          const prepared = await image.resizeIfNeeded(file);
          images.push({ data: prepared.data, mimeType: prepared.mimeType });
          content += (content ? '\n\n' : '') + '[Attached image: ' + file.name + ']';
        } else if (file.type.startsWith('audio/')) {
          if (file.size > 2 * 1024 * 1024) throw new Error('Each audio file must be 2 MB or smaller.');
          audios.push({ data: await fileAsBase64(file), mimeType: file.type || 'audio/webm' });
          content += (content ? '\n\n' : '') + '[Attached voice recording: ' + file.name + ']';
        } else if (file.type.startsWith('video/')) {
          const availableFrames = Math.min(4, 5 - images.length);
          if (availableFrames < 1) throw new Error('Attach fewer images so the tutor can also inspect your video.');
          const frames = await extractStudyVideoFrames(file, availableFrames);
          frames.forEach(frame => images.push({ data: frame.data, mimeType: frame.mimeType }));
          content += (content ? '\n\n' : '') + '[Video analysed from ' + frames.length + ' sampled keyframes at ' + frames.map(frame => frame.time.toFixed(1) + 's').join(', ') + '. The video audio track is not extracted; attach a separate audio recording if you need the speech analysed.]';
        } else {
          content += (content ? '\n\n' : '') + 'Study material: ' + file.name + '\n' + await extractStudyDocument(file);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'A selected file could not be prepared.');
      return;
    }
    if (!content.trim()) content = 'Please help me understand the attached study material.';
    const next = [...messages, { role: 'user' as const, content }];
    setMessages(next);
    setInput('');
    setFiles([]);
    setError('');
    setBusy(true);
    try {
      const response = await api.post('/api/study/tutor', {
        subject, level, topic, messages: next.slice(-12), images, audios,
      });
      const reply = response.data?.reply;
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('The tutor returned an empty answer.');
      const completedMessages = [...next, { role: 'assistant' as const, content: reply.trim() }];
      setMessages(completedMessages);
      await saveStudySession(completedMessages, { silent: true });
      if (voiceModeRef.current && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(reply.trim());
        utterance.lang = speechLanguage;
        utterance.rate = speechRate;
        utterance.voice = availableVoices.find(voice => voice.voiceURI === selectedVoice) || null;
        utterance.onend = () => { if (voiceModeRef.current) startStudyVoice(); };
        window.speechSynthesis.speak(utterance);
      }
    } catch (err) {
      const failure = err as { response?: { status?: number; data?: { error?: string } } };
      setError(failure.response?.data?.error || (failure.response?.status === 429 ? 'The shared AI service is temporarily at its usage limit. Please try again later.' : 'Your tutor could not respond. Please try again.'));
      await saveStudySession(next, { silent: true });
    } finally { setBusy(false); }
  }

  async function generateClassroomVisual(kind: 'teacher' | 'chart') {
    if (kind === 'teacher') setTeacherImageBusy(true);
    else setGraphicBusy(true);
    setError('');
    try {
      const prompt = kind === 'teacher'
        ? `Create a photorealistic, friendly ${teacherStyle} for a premium online learning classroom. Professional educator portrait, warm confident expression, smart modest classroom clothing, softly lit modern classroom background, shoulders-up composition, natural skin texture, realistic photography, no text, no watermark.`
        : `Create a beautiful, colourful educational infographic for a ${level} student studying ${subject}, topic: ${topic}. Show one clear accurate chart or diagram with a simple title, labelled shapes and a few short readable labels. Use a polished modern classroom presentation style, bright balanced colours, high contrast, clean layout, no fake data, no watermark.`;
      const response = await api.post('/api/generate-image', { prompt });
      const data = response.data;
      if (typeof data?.imageData !== 'string' || !data.imageData) throw new Error('The image service did not return an image.');
      const mimeType = typeof data.mimeType === 'string' ? data.mimeType : 'image/png';
      const imageUrl = `data:${mimeType};base64,${data.imageData}`;
      if (kind === 'teacher') setTeacherImage(imageUrl);
      else setLessonGraphic(imageUrl);
      setNotice(kind === 'teacher' ? 'Your AI teacher portrait is ready.' : 'Your colourful AI lesson graphic is ready.');
    } catch (err) {
      const failure = err as { response?: { data?: { error?: string } } };
      setError(failure.response?.data?.error || (err instanceof Error ? err.message : 'Could not create the classroom visual. Please try again.'));
    } finally {
      if (kind === 'teacher') setTeacherImageBusy(false);
      else setGraphicBusy(false);
    }
  }

  function startStudyVoice() {
    const browser = window as Window & { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    const Recognition = browser.SpeechRecognition || browser.webkitSpeechRecognition;
    if (!Recognition) { setError('Voice conversation needs a supported browser such as Chrome. Allow microphone access and try again.'); return; }
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = speechLanguage;
    recognition.onresult = event => {
      let transcript = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        if (event.results[index].isFinal) transcript += event.results[index][0].transcript;
      }
      if (transcript.trim()) {
        if (voiceModeRef.current) void sendStudyMessage(transcript.trim());
        else setInput(current => current ? current + ' ' + transcript.trim() : transcript.trim());
      }
    };
    recognition.onerror = () => { setListening(false); setError('Microphone access failed. Please allow microphone permission.'); };
    recognition.onend = () => setListening(false);
    speechRef.current = recognition;
    setListening(true);
    try { recognition.start(); } catch { setListening(false); setError('Could not start the microphone. Try again.'); }
  }

  function toggleStudyVoice() {
    if (voiceModeRef.current) {
      voiceModeRef.current = false;
      setVoiceMode(false);
      speechRef.current?.stop();
      speechRef.current = null;
      setListening(false);
      window.speechSynthesis?.cancel();
      return;
    }
    if (!('speechSynthesis' in window)) { setError('Spoken replies are not supported in this browser.'); return; }
    voiceModeRef.current = true;
    setVoiceMode(true);
    startStudyVoice();
  }

  function addStudyFiles(fileList: FileList | null) {
    if (!fileList) return;
    const accepted: File[] = [];
    for (const file of Array.from(fileList)) {
      const supported = file.type.startsWith('image/') || file.type.startsWith('video/') || file.type.startsWith('audio/') ||
        file.type === 'application/pdf' || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        ['text/plain', 'text/markdown', 'text/csv'].includes(file.type) || /\.(pdf|docx|txt|md|csv)$/i.test(file.name);
      if (!supported) { setError('Add an image, video, voice recording, PDF, DOCX or text document.'); continue; }
      const limit = file.type.startsWith('image/') ? 6 : file.type.startsWith('video/') ? 50 : file.type.startsWith('audio/') ? 2 : 10;
      if (file.size > limit * 1024 * 1024) { setError(file.name + ' is too large. Limit: ' + limit + ' MB.'); continue; }
      accepted.push(file);
    }
    setFiles(current => [...current, ...accepted].slice(0, 5));
  }

  function clearStudy() {
    setMessages([]);
    setInput('');
    setFiles([]);
    setError('');
    setNotice('A new lesson is ready. Your previous saved lessons remain in your history.');
    setLessonGraphic('');
    setActiveSessionId(createStudySessionId());
    setLessonCompleted(false);
    setSessionQuizAttempts(0);
    setSessionBestQuizPercent(0);
    setQuizScore('');
  }

  if (!user) return <section className="studio-page study-page"><div className="studio-heading"><div className="studio-icon"><GraduationCap size={22} /></div><div><div className="eyebrow">DAVIMTH LEARNING</div><h1>AI Study Buddy</h1><p>A patient personal tutor that helps you learn one step at a time.</p></div></div><div className="study-signin"><BookOpen size={34} /><h2>Your personal classroom starts here</h2><p>Sign in to chat with your tutor, upload study materials and save your lessons and progress securely to your account.</p>{authError && <div className="error-message" role="alert">{authError}</div>}<button className="primary-action" onClick={onSignIn} disabled={authLoading}>{authLoading ? 'Checking sign-in…' : 'Sign in to start learning'}</button></div></section>;

  return <section className="studio-page study-page">
    <div className="studio-heading"><div className="studio-icon"><GraduationCap size={22} /></div><div><div className="eyebrow">DAVIMTH LEARNING</div><h1>AI Study Buddy</h1><p>A friendly teacher for your lessons, questions and revision.</p></div></div>
    <div className="study-access-card"><div><span className="plan-label">YOUR LEARNING SPACE</span><h2>{isAdmin ? 'Administrator all-access' : 'Student learning space'}</h2><p>{isAdmin ? 'All Study Buddy and premium classroom features are unlocked for your administrator account.' : 'Start with the free personal tutor. Premium classroom upgrades will be available when subscriptions are connected.'}</p></div><span className={isAdmin ? 'study-admin-tag' : 'study-free-tag'}>{isAdmin ? 'ADMIN · FREE ACCESS' : 'FREE STUDY BUDDY'}</span></div>
    <div className="study-grid">
      <div className="study-main">
        <div className="business-panel study-tutor-panel">
          <div className="panel-heading"><h2><BookOpen size={18} /> Ask your tutor</h2><button type="button" className="study-clear" onClick={clearStudy}>Clear lesson</button></div>
          <div className="study-controls"><label>Subject<select value={subject} onChange={event => { setSubject(event.target.value); setTopic('Introduction'); clearStudy(); }}><option>Computer Science</option><option>Python Programming</option><option>English</option><option>Mathematics</option><option>Science</option><option>Business</option><option>History</option><option>Cybersecurity</option><option>Artificial Intelligence</option><option>Web Development</option><option>Other subject</option></select></label><label>Learning level<select value={level} onChange={event => { setLevel(event.target.value); clearStudy(); }}><option>Beginner</option><option>Primary school</option><option>Secondary school</option><option>University</option><option>Professional</option></select></label><label>Topic<input value={topic} onChange={event => setTopic(event.target.value)} placeholder="e.g. Python variables" /></label><button type="button" className="study-topic-button" onClick={clearStudy}>Start new topic</button></div>
          <div className="study-chat-context"><span>{subject}</span><span>{level}</span><span>{topic || 'New topic'}</span></div>
          <div className="study-chat-log" aria-live="polite">{messages.length ? messages.map((message,index) => <article className={'study-message ' + message.role} key={index}><strong>{message.role === 'assistant' ? 'DAVImth Tutor' : 'You'}</strong><p>{message.content}</p></article>) : <div className="study-welcome"><div className="study-teacher-icon"><GraduationCap size={28} /></div><h3>Hello, learner! 👋</h3><p>I'm your patient study tutor. Tell me what you want to learn, or choose a lesson below. I will explain simply, give examples and ask one question at a time.</p><div className="study-quick-prompts"><button type="button" onClick={() => void sendStudyMessage('Teach me ' + subject + ' from the very beginning. Use simple words and one small example at a time.')}>Start a lesson</button><button type="button" onClick={() => void sendStudyMessage('Give me a beginner-friendly practice quiz in ' + subject + '. Ask one question only and wait for my answer before giving the next question.')}>Practice quiz</button><button type="button" onClick={() => void sendStudyMessage('Help me understand a difficult topic in ' + subject + '. Ask me which topic if needed.')}>Explain a difficult topic</button></div></div>}</div>
          {busy && <div className="study-working"><span className="spinner" /> Your tutor is preparing an explanation…</div>}
          {files.length > 0 && <div className="study-file-list">{files.map((file,index) => <div className="study-file-chip" key={file.name + index}><span>{file.type.startsWith('video/') ? <Video size={14}/> : file.type.startsWith('audio/') ? <Headphones size={14}/> : file.type.startsWith('image/') ? <ImageIcon size={14}/> : <FileText size={14}/>}</span><span>{file.name}</span><button type="button" onClick={() => setFiles(current => current.filter((_,i) => i !== index))} aria-label={'Remove ' + file.name}><X size={13}/></button></div>)}</div>}
          {videoPreviews.length > 0 && <div className="study-video-preview-list">{videoPreviews.map(item => <video key={item.url} src={item.url} controls playsInline aria-label={'Preview ' + item.name} />)}</div>}
          <form className="study-composer" onSubmit={event => { event.preventDefault(); void sendStudyMessage(); }}>
            <input id="study-files" type="file" className="hidden-file-input" multiple accept="image/*,video/*,audio/*,.pdf,.docx,.txt,.md,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={event => { addStudyFiles(event.target.files); event.target.value = ''; }} />
            <textarea value={input} onChange={event => setInput(event.target.value)} placeholder="Ask your tutor anything…" rows={2} maxLength={5000} />
            <div className="study-composer-actions"><label htmlFor="study-files" className="study-attach"><Upload size={16}/> Add video, voice, image or PDF</label><button type="button" className={voiceMode ? 'study-voice active' : 'study-voice'} onClick={toggleStudyVoice}>{voiceMode ? <MicOff size={16}/> : <Mic size={16}/>} {voiceMode ? 'End voice lesson' : 'Voice conversation'}</button><button className="primary-action" type="submit" disabled={busy || (!input.trim() && !files.length)}><ArrowUp size={16}/> Send</button></div>
          </form>
          {listening && <p className="study-listening"><span className="online-dot"/> Listening… Speak clearly near your microphone.</p>}
          {error && <div className="error-message" role="alert">{error}</div>}
          {notice && <p className="study-notice">{notice}</p>}
          <p className="study-smallprint">Images, readable PDFs, Word and text documents can be shared with your tutor. Videos are analysed from a few sampled frames; the video's audio track is not extracted, so attach a voice recording separately for speech analysis. Voice conversation uses your browser microphone and spoken replies. Lessons and progress are saved to your account.</p>
        </div>
      </div>
      <aside className="study-side">
        <div className="business-panel study-progress"><h2>Your learning progress</h2><p>Lessons are saved to your account so you can return to them later.</p><div className="study-progress-line"><span>Subject</span><strong>{subject}</strong></div><div className="study-progress-line"><span>Level</span><strong>{level}</strong></div><div className="study-progress-line"><span>Lessons completed</span><strong>{studySummary.completedLessons}</strong></div><div className="study-progress-line"><span>Quiz attempts</span><strong>{studySummary.quizAttempts}</strong></div><div className="study-progress-line"><span>Best quiz score</span><strong>{studySummary.bestQuizPercent}%</strong></div><label className="study-history-select">Saved lessons<select value={studySessions.some(item => item.id === activeSessionId) ? activeSessionId : ''} onChange={event => openStudySession(event.target.value)}><option value="">Choose a saved lesson…</option>{studySessions.map(session => <option key={session.id} value={session.id}>{session.subject} · {session.topic} · {new Date(session.updatedAt).toLocaleDateString()}</option>)}</select></label><p className="study-smallprint">{studySessionsLoading ? 'Loading saved lessons…' : studySaving ? 'Saving your lesson…' : lessonCompleted ? 'This lesson is marked complete.' : 'Your current lesson is ready to continue.'}</p><div className="study-progress-actions"><button type="button" disabled={!messages.length || lessonCompleted || studySaving} onClick={() => void markLessonComplete()}>Mark lesson complete</button></div><div className="study-quiz-record"><strong>Record a quiz result</strong><div><label>Score<input type="number" min="0" max="100" value={quizScore} onChange={event => setQuizScore(event.target.value)} placeholder="e.g. 8" /></label><label>Out of<input type="number" min="1" max="100" value={quizTotal} onChange={event => setQuizTotal(event.target.value)} /></label></div><button type="button" disabled={!messages.length || !quizScore || studySaving} onClick={() => void recordQuizScore()}>Save quiz score</button></div></div>
                <div className="business-panel study-classroom-card"><div className="panel-heading"><h2><Video size={18}/> Premium AI Classroom</h2>{isAdmin ? <span className="study-admin-tag">UNLOCKED</span> : <span className="study-lock-tag"><LockKeyhole size={12}/> PREMIUM</span>}</div><div className="study-classroom-scene"><div className="study-classroom-board"><span>DAVIMth Virtual Classroom</span><strong>Learn · Practise · Grow</strong><i>✦</i></div><div className="study-classroom-teacher">{teacherImage ? <img className="study-teacher-photo" src={teacherImage} alt="Your AI classroom teacher" /> : <div className="study-teacher-avatar"><GraduationCap size={32}/></div>}<div><strong>AI Teacher</strong><small>{teacherStyle}</small></div></div></div><p>{isAdmin ? 'Your administrator account has free access to the premium classroom preview. The live talking human teacher connection is the next integration stage.' : 'A realistic human-like teacher, interactive whiteboard and live classroom conversation are planned for the premium upgrade.'}</p><button type="button" className="study-classroom-button" onClick={() => setClassroomOpen(value => !value)}>{classroomOpen ? 'Hide classroom details' : isAdmin ? 'Open classroom preview' : 'View premium classroom'}</button>{classroomOpen && <div className="study-classroom-details"><div className="study-live-classroom"><div className="study-live-teacher">{teacherImage ? <img className="study-live-teacher-photo" src={teacherImage} alt="Photorealistic AI teacher portrait" /> : <div className="study-live-avatar"><GraduationCap size={34}/></div>}<div><strong>DAVImth AI Teacher</strong><span>Virtual classroom · {subject}</span><small>{isAdmin ? 'Administrator premium access active' : 'Premium preview'}</small></div></div><div className="study-live-board"><span>CLASS WHITEBOARD</span><strong>{topic || 'Today’s lesson'}</strong><p>Your teacher will explain the topic, show examples and ask you questions one at a time.</p><div className="study-board-lines"><i/><i/><i/></div></div></div><div className="study-classroom-settings"><h3>Make your classroom yours</h3><div className="study-setting-grid"><label>Teacher appearance<select value={teacherStyle} onChange={event => setTeacherStyle(event.target.value)}><option>A warm African woman teacher</option><option>A friendly African man teacher</option><option>A professional woman science teacher</option><option>A professional man technology teacher</option><option>A friendly young university tutor</option></select></label><label>Speaking language<select value={speechLanguage} onChange={event => setSpeechLanguage(event.target.value)}><option value="en-NG">English (Nigeria)</option><option value="en-GB">English (United Kingdom)</option><option value="en-US">English (United States)</option><option value="yo-NG">Yoruba</option><option value="fr-FR">French</option></select></label><label>Available speaking voice<select value={selectedVoice} onChange={event => setSelectedVoice(event.target.value)}><option value="">Browser default voice</option>{availableVoices.map(voice => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}{voice.default ? ' · Default' : ''}</option>)}</select></label><label>Speaking speed <strong>{speechRate.toFixed(2)}×</strong><input type="range" min="0.7" max="1.25" step="0.05" value={speechRate} onChange={event => setSpeechRate(Number(event.target.value))} /></label></div><p className="study-voice-note">Voice choices depend on the voices installed in the student's browser or device. Some languages may not be available on every phone.</p><div className="study-visual-actions"><button type="button" disabled={teacherImageBusy} onClick={() => void generateClassroomVisual('teacher')}>{teacherImageBusy ? 'Creating teacher portrait…' : 'Create realistic teacher image'}</button><button type="button" disabled={graphicBusy} onClick={() => void generateClassroomVisual('chart')}>{graphicBusy ? 'Creating lesson graphic…' : 'Create AI chart / graphic'}</button></div>{lessonGraphic && <div className="study-generated-graphic"><div><strong>AI lesson graphic</strong><button type="button" onClick={() => setLessonGraphic('')}>Remove</button></div><img src={lessonGraphic} alt={`AI educational chart about ${topic}`} /></div>}</div><p>{isAdmin ? 'Test the classroom lesson and browser voice conversation here. The AI teacher can speak and listen using your selected browser voice. A live photorealistic speaking avatar video still requires a dedicated avatar/video provider.' : 'This is a classroom preview. Premium subscription access is not connected yet.'}</p><div className="study-classroom-actions"><button type="button" className="primary-action" disabled={busy} onClick={() => void sendStudyMessage('Welcome me to the virtual classroom. Teach me ' + topic + ' in ' + subject + ' at ' + level + ' level. Explain on a simple virtual whiteboard, use examples, and ask me one question at a time.')}> <BookOpen size={15}/> Begin classroom lesson</button><button type="button" className={voiceMode ? 'study-voice active' : 'study-voice'} onClick={toggleStudyVoice}>{voiceMode ? <MicOff size={15}/> : <Mic size={15}/>} {voiceMode ? 'End voice class' : 'Test voice class'}</button></div></div>}</div>
      </aside>
    </div>
    {accessLoading && <p className="study-smallprint">Checking administrator access…</p>}
  </section>;
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [listening, setListening] = useState(false);
  const [voiceConversation, setVoiceConversation] = useState(false);
  const voiceModeRef = useRef(false);
  const [voiceError, setVoiceError] = useState('');
  const speechRef = useRef<SpeechRecognitionLike | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<StudioTab>('chat');
  const [imagePrompt, setImagePrompt] = useState('');
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState('');
  const [generatedImage, setGeneratedImage] = useState('');
  const [imageUsage, setImageUsage] = useState(() => readImageUsage(USAGE_KEY + ':guest'));
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [records, setRecords] = useState<WorkspaceRecord[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const [recordKind, setRecordKind] = useState<'business' | 'task'>('task');
  const [recordTitle, setRecordTitle] = useState('');
  const [recordBusiness, setRecordBusiness] = useState('DAVIMART');
  const [recordDetail, setRecordDetail] = useState('');
  const [savingRecord, setSavingRecord] = useState(false);
  const [socialMode, setSocialMode] = useState<SocialMode>('manual');
  const [socialPlatform, setSocialPlatform] = useState('Facebook');
  const [socialContent, setSocialContent] = useState('');
  const [socialSchedule, setSocialSchedule] = useState('');
  const [socialDrafts, setSocialDrafts] = useState<SocialDraft[]>(readSocialDrafts);
  const [socialNotice, setSocialNotice] = useState('');
  const [socialMediaFile, setSocialMediaFile] = useState<File | null>(null);
  const [socialMediaPreview, setSocialMediaPreview] = useState('');
  const [savedSocialMedia, setSavedSocialMedia] = useState<Record<string, string>>({});
  const [socialBrief, setSocialBrief] = useState('');
  const [socialAiBusy, setSocialAiBusy] = useState(false);
  const [socialGeneratedPlan, setSocialGeneratedPlan] = useState('');
  const [supportBusinessName, setSupportBusinessName] = useState('');
  const [supportDescription, setSupportDescription] = useState('');
  const [supportKnowledge, setSupportKnowledge] = useState('');
  const [supportLoading, setSupportLoading] = useState(false);
  const [supportSaving, setSupportSaving] = useState(false);
  const [supportBusy, setSupportBusy] = useState(false);
  const [supportError, setSupportError] = useState('');
  const [supportNotice, setSupportNotice] = useState('');
  const [supportInput, setSupportInput] = useState('');
  const [supportMessages, setSupportMessages] = useState<Array<{ role: 'customer' | 'assistant'; content: string }>>([]);
  const [supportAssistants, setSupportAssistants] = useState<SupportAssistant[]>([]);
  const [supportSelectedAssistantId, setSupportSelectedAssistantId] = useState('');
  const [supportCreating, setSupportCreating] = useState(true);
  const [supportConversations, setSupportConversations] = useState<SupportConversation[]>([]);
  const [supportConversationId, setSupportConversationId] = useState('');
  const [supportConversationLoading, setSupportConversationLoading] = useState(false);
  const [supportStatusBusy, setSupportStatusBusy] = useState('');

  useEffect(() => {
    auth.getUser()
      .then(current => {
        if (current) {
          const sessionUser = sessionStorage.getItem('davimth-active-user');
          if (sessionUser !== current.userId) {
            localStorage.removeItem(CHAT_KEY);
            localStorage.removeItem('davimth-study-messages-v1');
            setConversations([]);
            setActiveConversationId('');
            setMessages([]);
          }
          sessionStorage.setItem('davimth-active-user', current.userId);
        }
        setImageUsage(readImageUsage(current ? USAGE_KEY + ':' + current.userId : USAGE_KEY + ':guest'));
        setUser(current);
      })
      .catch(() => setAuthError('Could not restore your sign-in. Please try again.'))
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(conversations)); } catch { /* Browser storage may be unavailable. */ }
  }, [conversations]);

  useEffect(() => {
    try { localStorage.setItem(SOCIAL_DRAFTS_KEY, JSON.stringify(socialDrafts)); } catch { setSocialNotice('Browser storage is unavailable. Drafts may not persist after closing this tab.'); }
  }, [socialDrafts]);

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    Promise.all(socialDrafts.filter(draft => draft.mediaName).map(async draft => {
      const blob = await readSocialMedia(draft.id).catch(() => null);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      return [draft.id, url] as const;
    })).then(entries => {
      if (!cancelled) setSavedSocialMedia(Object.fromEntries(entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))));
    });
    return () => { cancelled = true; urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [socialDrafts]);

  const canSend = useMemo(() => input.trim().length > 0 && !busy, [input, busy]);
  const imageDailyLimit = user ? 3 : 1;
  const imageUsageKey = user ? USAGE_KEY + ':' + user.userId : USAGE_KEY + ':guest';
  const imagesLeft = Math.max(0, imageDailyLimit - imageUsage.count);
  const businesses = records.filter(record => record.kind === 'business');
  const tasks = records.filter(record => record.kind === 'task');

  function saveConversation(nextMessages: Message[]) {
    if (!nextMessages.length) return;
    const id = activeConversationId || String(Date.now());
    if (!activeConversationId) setActiveConversationId(id);
    const firstUserText = nextMessages.find(message => message.role === 'user')?.content || 'New conversation';
    const title = firstUserText.length > 42 ? firstUserText.slice(0, 42) + '…' : firstUserText;
    const updated: Conversation = { id, title, messages: nextMessages, updatedAt: Date.now() };
    setConversations(current => [updated, ...current.filter(item => item.id !== id)].slice(0, 60));
  }

  function openConversation(conversation: Conversation) {
    if (busy) return;
    setActiveConversationId(conversation.id);
    setMessages(conversation.messages);
    setInput('');
    setErrorMessage('');
    setActiveTab('chat');
    setMenuOpen(false);
  }

  function deleteConversation(id: string) {
    const remaining = conversations.filter(item => item.id !== id);
    setConversations(remaining);
    if (activeConversationId === id) {
      const next = remaining[0];
      setActiveConversationId(next?.id || '');
      setMessages(next?.messages || []);
    }
  }

  async function signIn() {
    setAuthError('');
    sessionStorage.removeItem('davimth-active-user');
    try { await auth.signInWithRedirect(); }
    catch { setAuthError('Sign-in could not start. Check your browser settings and try again.'); }
  }

  async function signOut() {
    try { await auth.signOut(); }
    catch { setAuthError('Could not sign out safely. Please try again.'); return; }
    sessionStorage.removeItem('davimth-active-user');
    localStorage.removeItem(CHAT_KEY);
    localStorage.removeItem('davimth-study-messages-v1');
    setConversations([]);
    setActiveConversationId('');
    setMessages([]);
    setInput('');
    setAttachments([]);
    setUser(null);
    setImageUsage(readImageUsage(USAGE_KEY + ':guest'));
    setRecords([]);
    setActiveTab('chat');
  }

  async function loadWorkspace() {
    if (!user) return;
    setWorkspaceLoading(true);
    setWorkspaceError('');
    try {
      const response = await api.get('/api/workspace');
      setRecords(Array.isArray(response.data?.records) ? response.data.records : []);
    } catch {
      setWorkspaceError('Your business workspace could not load. Please refresh and try again.');
    } finally { setWorkspaceLoading(false); }
  }

  useEffect(() => {
    if (activeTab === 'business' && user) void loadWorkspace();
  }, [activeTab, user?.userId]);

  async function saveRecord(event: FormEvent) {
    event.preventDefault();
    if (!recordTitle.trim()) {
      setWorkspaceError(recordKind === 'business' ? 'Enter a business name.' : 'Enter a task title.');
      return;
    }
    setSavingRecord(true);
    setWorkspaceError('');
    try {
      await api.post('/api/workspace', {
        kind: recordKind,
        title: recordTitle.trim(),
        detail: recordDetail.trim(),
        businessName: recordKind === 'task' ? recordBusiness : recordTitle.trim(),
      });
      setRecordTitle('');
      setRecordDetail('');
      await loadWorkspace();
    } catch {
      setWorkspaceError('Could not save this record. Please try again.');
    } finally { setSavingRecord(false); }
  }

  async function updateTaskStatus(record: WorkspaceRecord) {
    const status = record.status === 'done' ? 'open' : 'done';
    try {
      await api.patch('/api/workspace/' + encodeURIComponent(record.id), { status });
      setRecords(current => current.map(item => item.id === record.id ? { ...item, status } : item));
    } catch { setWorkspaceError('Could not update the task. Please try again.'); }
  }

  async function loadSupportConversations(assistantId: string) {
    setSupportConversationLoading(true);
    try {
      const response = await api.get('/api/support/assistants/' + encodeURIComponent(assistantId) + '/conversations');
      const items = Array.isArray(response.data?.conversations) ? response.data.conversations as SupportConversation[] : [];
      setSupportConversations(items);
    } catch {
      setSupportError('Conversation history could not load. Please try again.');
    } finally { setSupportConversationLoading(false); }
  }

  async function loadSupportConfig() {
    if (!user) return;
    setSupportLoading(true);
    setSupportError('');
    try {
      const response = await api.get('/api/support/assistants');
      const assistants = Array.isArray(response.data?.assistants) ? response.data.assistants as SupportAssistant[] : [];
      setSupportAssistants(assistants);
      const selected = assistants.find(item => item.id === supportSelectedAssistantId) || assistants[0];
      if (selected) {
        setSupportSelectedAssistantId(selected.id);
        setSupportCreating(false);
        setSupportBusinessName(selected.businessName);
        setSupportDescription(selected.description);
        setSupportKnowledge(selected.knowledge);
        await loadSupportConversations(selected.id);
      } else {
        setSupportSelectedAssistantId('');
        setSupportCreating(true);
        setSupportBusinessName('');
        setSupportDescription('');
        setSupportKnowledge('');
        setSupportConversations([]);
        setSupportMessages([]);
        setSupportConversationId('');
      }
    } catch {
      setSupportError('Your support workspace could not load. Please refresh and try again.');
    } finally { setSupportLoading(false); }
  }

  useEffect(() => {
    if (activeTab === 'support' && user) void loadSupportConfig();
  }, [activeTab, user?.userId]);

  function selectSupportAssistant(assistant: SupportAssistant) {
    setSupportSelectedAssistantId(assistant.id);
    setSupportCreating(false);
    setSupportBusinessName(assistant.businessName);
    setSupportDescription(assistant.description);
    setSupportKnowledge(assistant.knowledge);
    setSupportMessages([]);
    setSupportConversationId('');
    setSupportInput('');
    void loadSupportConversations(assistant.id);
  }

  function startNewSupportAssistant() {
    setSupportSelectedAssistantId('');
    setSupportCreating(true);
    setSupportBusinessName('');
    setSupportDescription('');
    setSupportKnowledge('');
    setSupportMessages([]);
    setSupportConversationId('');
    setSupportInput('');
    setSupportError('');
    setSupportNotice('');
  }

  async function saveSupportConfig(event: FormEvent) {
    event.preventDefault();
    setSupportSaving(true);
    setSupportError('');
    setSupportNotice('');
    const payload = { businessName: supportBusinessName, description: supportDescription, knowledge: supportKnowledge };
    try {
      if (supportCreating || !supportSelectedAssistantId) {
        await api.post('/api/support/assistants', payload);
        setSupportNotice('Your new AI assistant has been created and saved to your account.');
      } else {
        await api.put('/api/support/assistants/' + encodeURIComponent(supportSelectedAssistantId), payload);
        setSupportNotice('Your assistant profile and business knowledge have been saved.');
      }
      setSupportCreating(false);
      await loadSupportConfig();
    } catch (err) {
      const failure = err as { response?: { data?: { error?: string } } };
      setSupportError(failure.response?.data?.error || 'Could not save your assistant. Please try again.');
    } finally { setSupportSaving(false); }
  }

  async function sendSupportTest(event: FormEvent) {
    event.preventDefault();
    const message = supportInput.trim();
    if (!message || supportBusy) return;
    if (!supportSelectedAssistantId || supportCreating) {
      setSupportError('Create and save an assistant before testing it.');
      return;
    }
    const assistantId = supportSelectedAssistantId;
    setSupportMessages(current => [...current, { role: 'customer', content: message }]);
    setSupportInput('');
    setSupportBusy(true);
    setSupportError('');
    try {
      const response = await api.post('/api/support/assistants/' + encodeURIComponent(assistantId) + '/chat', {
        message,
        ...(supportConversationId ? { conversationId: supportConversationId } : {}),
      });
      const reply = response.data?.reply;
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('No reply returned');
      if (typeof response.data?.conversationId === 'string') setSupportConversationId(response.data.conversationId);
      setSupportMessages(current => [...current, { role: 'assistant', content: reply.trim() }]);
      if (response.data?.needsHuman) setSupportNotice('This conversation has been flagged for human attention.');
      await loadSupportConversations(assistantId);
    } catch (err) {
      const failure = err as { response?: { data?: { error?: string } } };
      setSupportError(failure.response?.data?.error || 'The assistant could not reply. Please try again.');
    } finally { setSupportBusy(false); }
  }

  function openSupportConversation(conversation: SupportConversation) {
    setSupportConversationId(conversation.id);
    setSupportMessages(conversation.messages || []);
    setSupportInput('');
  }

  function startNewSupportConversation() {
    setSupportConversationId('');
    setSupportMessages([]);
    setSupportInput('');
    setSupportError('');
  }

  async function updateSupportConversationStatus(conversationId: string, status: 'open' | 'needs_human' | 'resolved') {
    if (!supportSelectedAssistantId) return;
    setSupportStatusBusy(conversationId);
    setSupportError('');
    try {
      await api.post('/api/support/assistants/' + encodeURIComponent(supportSelectedAssistantId) + '/conversations/' + encodeURIComponent(conversationId) + '/handover', { status });
      setSupportNotice(status === 'needs_human' ? 'Human handover requested. This conversation is now marked for your attention.' : status === 'resolved' ? 'Conversation marked as resolved.' : 'Conversation reopened.');
      await loadSupportConversations(supportSelectedAssistantId);
    } catch (err) {
      const failure = err as { response?: { data?: { error?: string } } };
      setSupportError(failure.response?.data?.error || 'Could not update the conversation. Please try again.');
    } finally { setSupportStatusBusy(''); }
  }

  function addAttachments(files: FileList | null) {
    if (!files) return;
    const accepted: File[] = [];
    for (const file of Array.from(files)) {
      const isImage = file.type.startsWith('image/');
      const isPdf = file.type === 'application/pdf' || /\\.pdf$/i.test(file.name);
      const isWord = file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\\.docx$/i.test(file.name);
      const isText = ['text/plain', 'text/markdown', 'text/csv', 'application/json'].includes(file.type) || /\\.(txt|md|csv|json)$/i.test(file.name);
      if (!isImage && !isText && !isPdf && !isWord) { setErrorMessage('Supported files: images, PDF, Word DOCX, TXT, MD, CSV and JSON.'); continue; }
      const maxBytes = isImage ? 6 * 1024 * 1024 : isText ? 150 * 1024 : 10 * 1024 * 1024;
      if (file.size > maxBytes) { setErrorMessage(isImage ? 'Each image must be 6 MB or smaller.' : isText ? 'Each text document must be 150 KB or smaller.' : 'Each PDF or Word document must be 10 MB or smaller.'); continue; }
      accepted.push(file);
    }
    setAttachments(current => [...current, ...accepted].slice(0, 5));
  }

  async function extractDocumentText(file: File): Promise<string> {
    if (/\\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      const pageCount = Math.min(pdf.numPages, 30);
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const textContent = await page.getTextContent();
        pages.push(textContent.items.map(item => 'str' in item ? item.str : '').join(' '));
      }
      const extracted = pages.join('\\n\\n').trim();
      if (!extracted) throw new Error('This PDF has no selectable text. Try uploading a clear photo of the page instead.');
      return extracted.slice(0, 12000);
    }
    if (/\\.docx$/i.test(file.name) || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      if (!result.value.trim()) throw new Error('No readable text was found in this Word document.');
      return result.value.slice(0, 12000);
    }
    return (await file.text()).slice(0, 12000);
  }

  function startVoiceInput() {
    const browser = window as Window & { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    const Recognition = browser.SpeechRecognition || browser.webkitSpeechRecognition;
    if (!Recognition) { setVoiceError('Voice input is not supported here. Try Chrome on Android and allow microphone access.'); voiceModeRef.current = false; setVoiceConversation(false); return; }
    setVoiceError('');
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-NG';
    recognition.onresult = event => {
      let transcript = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) transcript += result[0].transcript;
      }
      if (transcript.trim()) {
        if (voiceModeRef.current) void sendMessage(undefined, transcript.trim());
        else setInput(current => current ? current + ' ' + transcript.trim() : transcript.trim());
      }
    };
    recognition.onerror = () => { setListening(false); setVoiceError('Microphone access failed. Allow microphone permission and try again.'); if (voiceModeRef.current) { voiceModeRef.current = false; setVoiceConversation(false); } };
    recognition.onend = () => setListening(false);
    speechRef.current = recognition;
    setListening(true);
    try { recognition.start(); } catch { setListening(false); setVoiceError('Could not start the microphone. Please try again.'); }
  }

  function stopVoiceInput() {
    speechRef.current?.stop();
    speechRef.current = null;
    setListening(false);
  }

  function toggleVoiceConversation() {
    if (voiceModeRef.current) {
      voiceModeRef.current = false;
      setVoiceConversation(false);
      stopVoiceInput();
      window.speechSynthesis?.cancel();
      return;
    }
    if (!('speechSynthesis' in window)) { setVoiceError('Spoken replies are not supported by this browser. Try Chrome on Android.'); return; }
    voiceModeRef.current = true;
    setVoiceConversation(true);
    startVoiceInput();
  }

  function speakReply(reply: string) {
    if (!voiceModeRef.current || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(reply);
    utterance.lang = 'en-NG';
    utterance.rate = 1;
    utterance.onend = () => { if (voiceModeRef.current) startVoiceInput(); };
    window.speechSynthesis.speak(utterance);
  }

  async function sendMessage(event?: FormEvent, suggested?: string) {
    event?.preventDefault();
    const selected = attachments;
    const typedContent = (suggested ?? input).trim();
    if ((!typedContent && selected.length === 0) || busy) {
      if (!typedContent && selected.length === 0) setErrorMessage('Type a message or attach a file first.');
      return;
    }
    if (listening) stopVoiceInput();
    let content = typedContent;
    const images: Array<{ data: string; mimeType: string }> = [];
    try {
      for (const file of selected) {
        if (file.type.startsWith('image/')) {
          const prepared = await image.resizeIfNeeded(file);
          images.push({ data: prepared.data, mimeType: prepared.mimeType });
          content += (content ? '\\n\\n' : '') + '[Attached image: ' + file.name + ']';
        } else {
          const text = await extractDocumentText(file);
          content += (content ? '\\n\\n' : '') + 'Attached document: ' + file.name + '\\n' + text;
        }
      }
    } catch { setErrorMessage('A selected file could not be prepared. Please try another file.'); return; }
    if (!content.trim()) content = 'Please describe the attached image(s).';
    const nextMessages: Message[] = [...messages, { role: 'user', content }];
    setMessages(nextMessages);
    saveConversation(nextMessages);
    setInput('');
    setAttachments([]);
    setErrorMessage('');
    setBusy(true);
    try {
      const response = await api.post('/api/chat', { messages: nextMessages.slice(-12), images });
      const reply = response.data?.reply;
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('Empty response');
      const completed = [...nextMessages, { role: 'assistant' as const, content: reply }];
      setMessages(completed);
      saveConversation(completed);
      speakReply(reply);
    } catch { setErrorMessage('DAVImth could not respond just now. Please try again.'); }
    finally { setBusy(false); }
  }

  async function createImage(event: FormEvent) {
    event.preventDefault();
    const prompt = imagePrompt.trim();
    if (!prompt) { setImageError('Describe the image you want to create.'); return; }
    const latestUsage = readImageUsage(imageUsageKey);
    setImageUsage(latestUsage);
    if (latestUsage.count >= imageDailyLimit) {
      setImageError('Your free image for today has been used. Your free allowance refreshes tomorrow.');
      return;
    }
    setImageBusy(true);
    setImageError('');
    setGeneratedImage('');
    try {
      const response = await api.post('/api/generate-image', { prompt });
      const data = response.data;
      if (typeof data?.imageData !== 'string' || !data.imageData) throw new Error('No image returned');
      const mimeType = typeof data.mimeType === 'string' ? data.mimeType : 'image/png';
      setGeneratedImage(`data:${mimeType};base64,${data.imageData}`);
      const nextUsage = { date: todayKey(), count: latestUsage.count + 1 };
      localStorage.setItem(imageUsageKey, JSON.stringify(nextUsage));
      setImageUsage(nextUsage);
    } catch (err) {
      const failure = err as {
        message?: string;
        response?: { data?: { error?: string } };
      };
      const detail = [
        failure?.response?.data?.error,
        failure?.message,
        String(err),
      ].filter(Boolean).join(' ').toLowerCase();
      if (detail.includes('429') || detail.includes('daily') || detail.includes('usage limit')) {
        setImageError('The free image service has reached its shared daily limit. It should reset at 1:00 a.m. Nigeria time. Please try again after then.');
      } else {
        setImageError(failure?.response?.data?.error || 'Image creation failed. Please try again in a moment.');
      }
    } finally { setImageBusy(false); }
  }

  async function generateSocialText(action: 'caption' | 'hashtags' | 'format' | 'video-plan') {
    const brief = socialBrief.trim() || socialContent.trim();
    if (!brief) { setSocialNotice('First describe the product, service, offer or idea you want to promote.'); return; }
    setSocialAiBusy(true);
    setSocialNotice('DAVImth is preparing your content...');
    try {
      const response = await api.post('/api/social-assist', { action, platform: socialPlatform, brief, caption: socialContent });
      const output = response.data?.text;
      if (typeof output !== 'string' || !output.trim()) throw new Error('No content returned');
      if (action === 'video-plan') setSocialGeneratedPlan(output.trim());
      else if (action === 'hashtags') setSocialContent(current => `${current.trim()}${current.trim() ? '\\n\\n' : ''}${output.trim()}`);
      else setSocialContent(output.trim());
      setSocialNotice(action === 'video-plan' ? 'Your video script and storyboard are ready. This is a production plan, not a rendered video file.' : 'Your AI-assisted social content is ready. Review and edit it before saving.');
    } catch (err) {
      const failure = err as { response?: { data?: { error?: string } } };
      setSocialNotice(failure.response?.data?.error || 'AI content generation is temporarily unavailable. Please try again.');
    } finally { setSocialAiBusy(false); }
  }

  async function generateSocialImage() {
    const brief = socialBrief.trim() || socialContent.trim();
    if (!brief) { setSocialNotice('Describe the product or campaign before creating an image.'); return; }
    setSocialAiBusy(true);
    setSocialNotice('Creating your marketing image...');
    try {
      const response = await api.post('/api/generate-image', { prompt: `Create a polished social media marketing visual for ${socialPlatform}. Campaign brief: ${brief}. Use a clean professional composition, strong visual hierarchy and no fake logos or unreadable text.` });
      const data = response.data;
      if (typeof data?.imageData !== 'string' || !data.imageData) throw new Error('No image returned');
      const binary = atob(data.imageData);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const mimeType = typeof data.mimeType === 'string' ? data.mimeType : 'image/png';
      chooseSocialMedia(new File([bytes], 'davimth-social-creative.png', { type: mimeType }));
      setSocialNotice('AI marketing image created and attached to your post. Review it before saving.');
    } catch (err) {
      const failure = err as { response?: { data?: { error?: string } } };
      setSocialNotice(failure.response?.data?.error || 'Image creation is temporarily unavailable. Please try again later.');
    } finally { setSocialAiBusy(false); }
  }

  async function saveSocialDraft(event: FormEvent) {
    event.preventDefault();
    if (!socialContent.trim() && !socialMediaFile) { setSocialNotice('Add a caption or choose an image/video before saving your post.'); return; }
    const id = String(Date.now());
    try {
      if (socialMediaFile) await saveSocialMedia(id, socialMediaFile);
      const draft: SocialDraft = {
        id, platform: socialPlatform, content: socialContent.trim(), mode: socialMode,
        schedule: socialSchedule, status: socialMode === 'approval' ? 'Awaiting approval' : 'Draft', createdAt: Date.now(),
        ...(socialMediaFile ? { mediaName: socialMediaFile.name, mediaType: socialMediaFile.type, mediaSize: socialMediaFile.size } : {}),
      };
      setSocialDrafts(current => [draft, ...current].slice(0, 100));
      setSocialContent('');
      setSocialSchedule('');
      if (socialMediaPreview) URL.revokeObjectURL(socialMediaPreview);
      setSocialMediaPreview('');
      setSocialMediaFile(null);
      setSocialNotice(socialMode === 'approval' ? 'Saved with its media. This post is waiting for your approval; it has not been published.' : 'Draft saved with its media. Download the media and publish manually on your selected platform.');
    } catch {
      setSocialNotice('The media could not be saved in this browser. Try a smaller file or another browser.');
    }
  }

  function chooseSocialMedia(file: File | null) {
    if (socialMediaPreview) URL.revokeObjectURL(socialMediaPreview);
    setSocialMediaPreview('');
    setSocialMediaFile(null);
    if (!file) return;
    if (!(file.type.startsWith('image/') || file.type.startsWith('video/'))) {
      setSocialNotice('Choose an image or video file.');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setSocialNotice('Please choose a file smaller than 50 MB for this browser-based draft workspace.');
      return;
    }
    setSocialMediaFile(file);
    setSocialMediaPreview(URL.createObjectURL(file));
    setSocialNotice('Media selected. It will be saved with your post draft on this device.');
  }

  function approveSocialDraft(id: string) {
    setSocialDrafts(current => current.map(draft => draft.id === id ? { ...draft, status: 'Approved' } : draft));
    setSocialNotice('Approved in DAVImth. Live publishing is not connected yet, so this post has not been sent to the platform.');
  }

  async function copySocialDraft(content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setSocialNotice('Post copied. Open the social platform and paste it there.');
    } catch { setSocialNotice('Copy was blocked by your browser. Select the post text and copy it manually.'); }
  }

  function startNewChat() {
    setActiveConversationId('');
    setMessages([]);
    setInput('');
    setErrorMessage('');
    setMenuOpen(false);
    setActiveTab('chat');
  }

  function navigate(tab: StudioTab) {
    setActiveTab(tab);
    setMenuOpen(false);
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><BrainCircuit size={23} /></div>
          <div><strong>DAVImth</strong><span>INTELLIGENCE</span></div>
          <button className="icon-button close-menu" onClick={() => setMenuOpen(false)} aria-label="Close menu"><X size={19} /></button>
        </div>
        <button className="new-chat" onClick={startNewChat}><Plus size={18} /> New conversation</button>
        <div className="side-caption">WORKSPACE</div>
        <button className={`nav-item ${activeTab === 'chat' ? 'selected' : ''}`} onClick={() => navigate('chat')}><MessageSquare size={17} /> AI Chat</button>
        <button className={`nav-item ${activeTab === 'autonomy' ? 'selected' : ''}`} onClick={() => navigate('autonomy')}><BrainCircuit size={17} /> Autonomous Intelligence</button>
        <button className={`nav-item ${activeTab === 'business' ? 'selected' : ''}`} onClick={() => navigate('business')}><BriefcaseBusiness size={17} /> Business Hub</button>
        <button className={`nav-item ${activeTab === 'support' ? 'selected' : ''}`} onClick={() => navigate('support')}><Bot size={17} /> AI Customer Support</button>
        <button className={`nav-item ${activeTab === 'social' ? 'selected' : ''}`} onClick={() => navigate('social')}><Share2 size={17} /> Social & Marketing</button>
        <button className={`nav-item ${activeTab === 'image' ? 'selected' : ''}`} onClick={() => navigate('image')}><ImagePlus size={17} /> Image Creator <span className="free-tag">FREE</span></button>
        <button className={`nav-item ${activeTab === 'video' ? 'selected' : ''}`} onClick={() => navigate('video')}><Video size={17} /> Video Studio</button>
        <button className={`nav-item ${activeTab === 'study' ? 'selected' : ''}`} onClick={() => navigate('study')}><GraduationCap size={17} /> AI Study Buddy <span className="free-tag">NEW</span></button>
        <div className="side-caption">RECENT CHATS</div>
        <div className="history-list">
          {conversations.length ? conversations.map(conversation => (
            <div className={`history-item ${activeConversationId === conversation.id && activeTab === 'chat' ? 'history-selected' : ''}`} key={conversation.id}>
              <button className="history-open" onClick={() => openConversation(conversation)} title={conversation.title}><MessageSquare size={14} /><span>{conversation.title}</span></button>
              <button className="history-delete" onClick={() => deleteConversation(conversation.id)} aria-label="Delete conversation" title="Delete conversation">×</button>
            </div>
          )) : <p className="history-empty">Your conversations will appear here.</p>}
        </div>
        <div className="sidebar-bottom"><div className="online-dot" /><span>{user ? 'Workspace signed in' : 'AI assistant ready'}</span><span className="version">V1.2</span></div>
      </aside>

      {menuOpen && <button className="scrim" aria-label="Close menu" onClick={() => setMenuOpen(false)} />}
      <main className="main-panel">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setMenuOpen(true)} aria-label="Open menu"><Menu size={20} /></button>
          <div className="topbar-title"><span className="status-pulse" /> DAVImth AI <span className="topbar-subtitle">{activeTab === 'chat' ? 'Personal intelligence' : activeTab === 'autonomy' ? 'Autonomous intelligence' : activeTab === 'study' ? 'Friendly learning space' : activeTab === 'image' ? 'AI image creator' : activeTab === 'video' ? 'AI video studio' : activeTab === 'social' ? 'Social & marketing hub' : 'Business control centre'}</span></div>
          {user ? <button className="top-new-chat" onClick={signOut}><LogOut size={15} /><span>Sign out</span></button> : <button className="top-new-chat" onClick={signIn}><LogIn size={15} /><span>Sign in</span></button>}
        </header>

        {activeTab === 'chat' && <>
          <section className={`conversation ${messages.length ? 'conversation-active' : ''}`}>
            {messages.length === 0 ? <div className="welcome">
              <div className="hero-orb"><div className="orb-core"><BrainCircuit size={35} /></div><span className="orb-ring ring-one" /><span className="orb-ring ring-two" /></div>
              <div className="eyebrow"><Sparkles size={13} /> THINK BEYOND LIMITS</div>
              <h1>Your ideas.<br /><span>Intelligence amplified.</span></h1>
              <p className="welcome-copy">Hello, I'm DAVImth. Ask me anything, explore an idea, or let's solve something together.</p>
              <div className="suggestion-grid">{starterPrompts.map((prompt, index) => <button className="suggestion-card" key={prompt} onClick={() => sendMessage(undefined, prompt)}><span className="suggestion-icon">{index === 0 ? <BrainCircuit size={17} /> : index === 1 ? <Sparkles size={17} /> : <Bot size={17} />}</span><span>{prompt}</span><ArrowUp className="suggestion-arrow" size={15} /></button>)}</div>
            </div> : <div className="message-list">
              {messages.map((message, index) => <article className={`message-row ${message.role}`} key={index}><div className={`avatar ${message.role}`}>{message.role === 'assistant' ? <BrainCircuit size={18} /> : 'Y'}</div><div className="message-body"><div className="message-author">{message.role === 'assistant' ? 'DAVImth' : 'You'}</div><div className="message-content">{message.content}</div>{message.role === 'assistant' && <button className="message-copy" type="button" onClick={() => { void navigator.clipboard?.writeText(message.content); }} aria-label="Copy response"><Copy size={13}/> Copy</button>}</div></article>)}
              {busy && <div className="message-row assistant"><div className="avatar assistant"><BrainCircuit size={18} /></div><div className="message-body"><div className="message-author">DAVImth</div><div className="typing"><i /><i /><i /></div></div></div>}
              <div className="end-anchor" />
            </div>}
          </section>
          <div className="composer-wrap">
            {errorMessage && <div className="error-message" role="alert">{errorMessage}</div>}
            <form className="composer composer-expanded" onSubmit={sendMessage}>
              <input className="hidden-file-input" id="davimth-file-picker" type="file" accept="image/*,.pdf,.docx,.txt,.md,.csv,.json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple onChange={event => { addAttachments(event.target.files); event.target.value = ''; }} />
              <input className="hidden-file-input" id="davimth-camera-picker" type="file" accept="image/*" capture="environment" onChange={event => { addAttachments(event.target.files); event.target.value = ''; }} />
              {attachments.length > 0 && <div className="attachment-list">{attachments.map((file, index) => <div className="attachment-chip" key={file.name + index}>{file.type.startsWith('image/') ? <ImageIcon size={14} /> : <FileText size={14} />}<span>{file.name}</span><button type="button" aria-label={'Remove ' + file.name} onClick={() => setAttachments(current => current.filter((_, itemIndex) => itemIndex !== index))}><X size={13} /></button></div>)}</div>}
              <textarea value={input} onChange={event => { setInput(event.target.value); if (errorMessage) setErrorMessage(''); }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} placeholder="Message DAVImth..." rows={1} aria-label="Message DAVImth" maxLength={4000} />
              <div className="composer-tools">
                <div className="composer-actions">
                  <label className="composer-tool" htmlFor="davimth-file-picker" title="Upload images or documents"><Paperclip size={18} /><span>Attach</span></label>
                  <label className="composer-tool" htmlFor="davimth-camera-picker" title="Take a photo"><Camera size={18} /><span>Camera</span></label>
                  <button className={'composer-tool ' + (listening && !voiceConversation ? 'tool-active' : '')} type="button" onClick={listening && !voiceConversation ? stopVoiceInput : startVoiceInput} title={listening ? 'Stop voice typing' : 'Dictate a message'}>{listening && !voiceConversation ? <MicOff size={18} /> : <Mic size={18} />}<span>Voice typing</span></button>
                  <button className={'composer-tool ' + (voiceConversation ? 'tool-active' : '')} type="button" onClick={toggleVoiceConversation} title={voiceConversation ? 'End voice conversation' : 'Start two-way voice conversation'}>{voiceConversation ? <MicOff size={18} /> : <Bot size={18} />}<span>{voiceConversation ? 'End voice chat' : 'Voice chat'}</span></button>
                </div>
                <button className="send-button" type="submit" disabled={(!canSend && attachments.length === 0)} aria-label="Send message"><ArrowUp size={19} /></button>
              </div>
              {voiceError && <div className="voice-error" role="status">{voiceError}</div>}
            </form>
            <div className="composer-foot"><span><Sparkles size={12} /> Powerful thinking. Clear answers.</span><span>Images, PDF and DOCX supported · Voice chat uses your browser.</span></div>
          </div>
        </>}

        {activeTab === 'study' && <StudyBuddy user={user} authLoading={authLoading} authError={authError} onSignIn={signIn} />}
        {activeTab === 'autonomy' && <AutonomyCenter user={user} onSignIn={signIn} />}

        {activeTab === 'social' && <section className="studio-page social-page">
          <div className="studio-heading"><div className="studio-icon"><Share2 size={22} /></div><div><div className="eyebrow">DAVIMTH GROWTH</div><h1>Social & Marketing Hub</h1><p>Plan content for your brand and prepare posts for your social channels.</p></div></div>
          <div className="social-intro"><div><strong>One workspace for every kind of business</strong><p>Individuals, creators, small businesses and larger teams can prepare content here.</p></div><span className="social-status">Planning workspace</span></div>
          <div className="social-platform-grid">
            {socialPlatforms.map(platform => <article className="social-platform" key={platform}><div className="social-platform-icon"><Share2 size={17} /></div><div className="social-platform-copy"><strong>{platform}</strong><span>Official connection setup required</span></div><button type="button" onClick={() => setSocialNotice(`${platform} is not connected yet. A verified developer app, official API permissions and secure OAuth setup are required before account linking or publishing can be enabled.`)}>Setup</button></article>)}
          </div>
          <div className="social-mode-card"><div className="panel-heading"><h2>Choose how to manage posts</h2><span>Switch whenever you need</span></div><div className="social-mode-switch"><button type="button" className={socialMode === 'manual' ? 'active' : ''} onClick={() => setSocialMode('manual')}><ClipboardList size={16} /> Manual publishing</button><button type="button" className={socialMode === 'approval' ? 'active' : ''} onClick={() => setSocialMode('approval')}><CheckCircle2 size={16} /> Approval workflow</button></div><p>{socialMode === 'manual' ? 'DAVImth helps write and save your post. You copy it and publish it yourself on the social platform.' : 'DAVImth saves posts in an approval queue. You review and approve each post. Approval here does not publish it until an official platform connection is configured.'}</p></div>
          <div className="business-panel social-ai-panel">
            <div className="panel-heading"><h2><Sparkles size={18} /> AI Content Creator</h2><span>Ideas into ready-to-review content</span></div>
            <label htmlFor="social-brief">What are you promoting?</label>
            <textarea id="social-brief" value={socialBrief} onChange={event => setSocialBrief(event.target.value)} rows={3} maxLength={1200} placeholder="Example: A weekend discount on phone accessories for students..." />
            <div className="social-ai-actions">
              <button type="button" disabled={socialAiBusy} onClick={() => void generateSocialText('caption')}><Sparkles size={15} /> AI caption</button>
              <button type="button" disabled={socialAiBusy} onClick={() => void generateSocialText('hashtags')}># Hashtags</button>
              <button type="button" disabled={socialAiBusy} onClick={() => void generateSocialText('format')}>Format for {socialPlatform}</button>
              <button type="button" disabled={socialAiBusy} onClick={() => void generateSocialImage()}><ImagePlus size={15} /> Create image</button>
              <button type="button" disabled={socialAiBusy} onClick={() => void generateSocialText('video-plan')}><Video size={15} /> Video script & storyboard</button>
            </div>
            {socialAiBusy && <p className="social-ai-status">DAVImth is working on your content…</p>}
            {socialGeneratedPlan && <div className="social-video-plan"><strong>Video production plan</strong><pre>{socialGeneratedPlan}</pre><button type="button" onClick={() => { setSocialContent(current => `${current.trim()}${current.trim() ? '\\n\\n' : ''}${socialGeneratedPlan}`); setSocialNotice('Video script copied into your post caption.'); }}>Add script to caption</button></div>}
            <p className="social-media-hint">AI results are drafts for you to review. Image generation uses the shared image service allowance. Video script generation creates a production plan, not a video file.</p>
          </div>
          <div className="social-workspace-grid">
            <div className="business-panel social-composer"><div className="panel-heading"><h2>Create a social post</h2><span>Text, image or video</span></div><form className="record-form" onSubmit={saveSocialDraft}><label htmlFor="social-platform">Social platform</label><select id="social-platform" value={socialPlatform} onChange={event => setSocialPlatform(event.target.value)}>{socialPlatforms.map(platform => <option key={platform} value={platform}>{platform}</option>)}</select><label htmlFor="social-content">Post caption</label><textarea id="social-content" value={socialContent} onChange={event => setSocialContent(event.target.value)} placeholder="Write a caption, announcement or description..." rows={6} maxLength={5000} /><div className="social-character-count">{socialContent.length}/5000 characters</div><label htmlFor="social-media-file">Add image or video (optional)</label><input id="social-media-file" className="social-media-input" type="file" accept="image/*,video/mp4,video/webm,video/quicktime" onChange={event => { chooseSocialMedia(event.target.files?.[0] || null); event.target.value = ''; }} /><p className="social-media-hint">Images and videos up to 50 MB. Media is saved on this device in this browser.</p>{socialMediaPreview && <div className="social-media-preview">{socialMediaFile?.type.startsWith('video/') ? <video src={socialMediaPreview} controls playsInline /> : <img src={socialMediaPreview} alt="Selected post preview" />}<div><strong>{socialMediaFile?.name}</strong><button type="button" onClick={() => chooseSocialMedia(null)}>Remove media</button></div></div>}<label htmlFor="social-schedule">Planned date and time (optional)</label><input id="social-schedule" type="datetime-local" value={socialSchedule} onChange={event => setSocialSchedule(event.target.value)} /><button className="primary-action" type="submit"><Plus size={16} /> Save {socialMode === 'approval' ? 'for approval' : 'draft'}</button></form></div>
            <div className="business-panel social-drafts"><div className="panel-heading"><h2>Your post drafts</h2><span>{socialDrafts.length} saved in this browser</span></div>{socialDrafts.length ? <div className="social-draft-list">{socialDrafts.map(draft => <article className="social-draft" key={draft.id}><div className="social-draft-meta"><strong>{draft.platform}</strong><span className={'social-draft-status ' + (draft.status === 'Approved' ? 'approved' : draft.status === 'Awaiting approval' ? 'waiting' : '')}>{draft.status}</span></div>{draft.content && <p>{draft.content}</p>}{draft.mediaName && savedSocialMedia[draft.id] && <div className="social-saved-media">{draft.mediaType?.startsWith('video/') ? <video src={savedSocialMedia[draft.id]} controls playsInline /> : <img src={savedSocialMedia[draft.id]} alt={draft.mediaName} />}<a href={savedSocialMedia[draft.id]} download={draft.mediaName}><Download size={14} /> Download media</a></div>}{draft.schedule && <small><CalendarDays size={13} /> Planned: {new Date(draft.schedule).toLocaleString()}</small>}<div className="social-draft-actions"><button type="button" onClick={() => void copySocialDraft(draft.content)} disabled={!draft.content}><Copy size={14} /> Copy caption</button>{draft.status === 'Awaiting approval' && <button type="button" onClick={() => approveSocialDraft(draft.id)}><CheckCircle2 size={14} /> Approve</button>}</div></article>)}</div> : <p className="empty-state">Your saved posts will appear here. Create your first post to get started.</p>}</div>
          </div>
          <div className="business-panel social-calendar"><div className="panel-heading"><h2><CalendarDays size={18} /> Content calendar</h2><span>{socialDrafts.filter(draft => draft.schedule).length} planned posts</span></div>{socialDrafts.some(draft => draft.schedule) ? <div className="social-calendar-list">{socialDrafts.filter(draft => draft.schedule).sort((a, b) => new Date(a.schedule).getTime() - new Date(b.schedule).getTime()).map(draft => <div className="social-calendar-item" key={draft.id}><div><strong>{draft.platform}</strong><span>{draft.content.slice(0, 100) || draft.mediaName || 'Media post'}{draft.content.length > 100 ? '…' : ''}</span></div><small>{new Date(draft.schedule).toLocaleString()}</small><em>{draft.status}</em></div>)}</div> : <p className="empty-state">Choose a planned date and time when creating a post to see it here. Calendar entries are reminders only; they do not publish automatically.</p>}</div>
          {socialNotice && <div className="automation-note social-notice"><Link2 size={17} /><div><strong>Social workspace update</strong><p>{socialNotice}</p></div><button type="button" aria-label="Dismiss notice" onClick={() => setSocialNotice('')}>×</button></div>}
          <p className="studio-footnote">Connection status: no social accounts are connected yet. You can prepare text, image and video posts here, then download media and publish manually. Live media publishing, inbox management and analytics require official platform integrations, customer authorization and required reviews. Draft captions are stored in this browser; attached media is stored in this browser's local database. Nothing is synced across devices.</p>
        </section>}

        {activeTab === 'support' && <section className="studio-page support-page">
          <div className="studio-heading"><div className="studio-icon"><Bot size={22} /></div><div><div className="eyebrow">DAVIMTH SERVICE DESK</div><h1>AI Customer Support</h1><p>Create and manage separate AI assistants for DAVImth and your business customers.</p></div></div>
          {!user ? <div className="business-signin"><div className="business-signin-icon"><Bot size={28} /></div><h2>Manage your AI assistants</h2><p>Sign in to create business-specific assistants, save knowledge and review customer conversations.</p>{authError && <div className="error-message" role="alert">{authError}</div>}<button className="primary-action" onClick={signIn} disabled={authLoading}>{authLoading ? 'Checking sign-in...' : <><LogIn size={17} /> Sign in to continue</>}</button></div> : <>
            <div className="support-status-card"><div><span className="plan-label">SUPPORT WORKSPACE</span><h2>{supportAssistants.length} saved assistant{supportAssistants.length === 1 ? '' : 's'}</h2><p>Each assistant has its own business profile, FAQs, test conversations and handover status. Customer-facing channels remain separate until connected.</p></div><span className="social-status">Owner workspace</span></div>
            <div className="support-assistant-toolbar"><div><h2>Your AI assistants</h2><p>Create one assistant for each business or service.</p></div><button className="primary-action" type="button" onClick={startNewSupportAssistant}><Plus size={16} /> Create assistant</button></div>
            {supportAssistants.length > 0 && <div className="support-assistant-grid">{supportAssistants.map(assistant => <button type="button" className={'support-assistant-card ' + (supportSelectedAssistantId === assistant.id && !supportCreating ? 'active' : '')} key={assistant.id} onClick={() => selectSupportAssistant(assistant)}><span className="support-assistant-icon"><Building2 size={18} /></span><span className="support-assistant-copy"><strong>{assistant.businessName}</strong><small>{assistant.description}</small></span><span className="support-assistant-tag">AI assistant</span></button>)}</div>}
            {supportLoading && <p className="empty-state">Loading your assistants...</p>}
            <div className="business-panel support-setup-panel"><div className="panel-heading"><h2>{supportCreating ? 'Create a business assistant' : 'Business knowledge and settings'}</h2><span>Private to your account</span></div>
              <form className="record-form" onSubmit={saveSupportConfig}>
                <label htmlFor="support-business-name">Business name</label><input id="support-business-name" value={supportBusinessName} onChange={event => setSupportBusinessName(event.target.value)} placeholder="e.g. DAVITECH" maxLength={100} required />
                <label htmlFor="support-description">What does this business do?</label><textarea id="support-description" value={supportDescription} onChange={event => setSupportDescription(event.target.value)} rows={3} maxLength={1500} placeholder="Describe products, services and customers..." required />
                <label htmlFor="support-knowledge">FAQs, prices, opening hours and policies</label><textarea id="support-knowledge" value={supportKnowledge} onChange={event => setSupportKnowledge(event.target.value)} rows={7} maxLength={12000} placeholder={'Example:\nServices: ...\nPrices: ...\nOpening hours: ...\nDelivery: ...\nReturns and refunds: ...\nHuman contact: ...'} />
                <p className="support-hint">Only add information you are comfortable using to answer customers. Never upload passwords, bank details or private customer records.</p>
                <button className="primary-action" type="submit" disabled={supportSaving || supportLoading}>{supportSaving ? 'Saving assistant...' : <><Check size={16} /> {supportCreating ? 'Create assistant' : 'Save assistant'}</>}</button>
              </form>
            </div>
            {!supportCreating && supportSelectedAssistantId ? <>
              <div className="business-panel support-test-panel"><div className="panel-heading"><h2>Test this AI assistant</h2><span>Owner preview · saved business knowledge</span></div>
                <p className="support-hint">Ask about a service, price or policy. Answers are generated using this assistant's saved business profile and FAQs. Unknown answers should be referred to a human.</p>
                <div className="support-chat-log">{supportMessages.length ? supportMessages.map((item, index) => <div className={'support-chat-message ' + item.role} key={index}><strong>{item.role === 'customer' ? 'Customer' : 'DAVImth AI'}</strong><p>{item.content}</p></div>) : <p className="empty-state">Start a new test conversation or open one from conversation history.</p>}{supportBusy && <div className="support-chat-message assistant"><strong>DAVImth AI</strong><p>Preparing a reply...</p></div>}</div>
                <form className="support-chat-form" onSubmit={sendSupportTest}><input aria-label="Customer test question" value={supportInput} onChange={event => setSupportInput(event.target.value)} placeholder="Ask about a service, price or policy..." maxLength={3000} /><button className="primary-action" type="submit" disabled={supportBusy || !supportInput.trim()}>Send test</button></form>
                {supportConversationId && <div className="support-chat-actions"><button type="button" onClick={() => startNewSupportConversation()}><Plus size={14} /> New test conversation</button><button type="button" onClick={() => void updateSupportConversationStatus(supportConversationId, 'needs_human')} disabled={supportStatusBusy === supportConversationId}>Request human handover</button></div>}
              </div>
              <div className="business-panel support-history-panel"><div className="panel-heading"><h2>Conversation history & human handover</h2><span>{supportConversations.length} saved conversations</span></div>
                {supportConversationLoading ? <p className="empty-state">Loading conversations...</p> : supportConversations.length ? <div className="support-history-list">{supportConversations.map(conversation => { const firstMessage = conversation.messages?.find(item => item.role === 'customer')?.content || 'Customer conversation'; return <article className="support-history-item" key={conversation.id}><button type="button" className="support-history-open" onClick={() => openSupportConversation(conversation)}><strong>{firstMessage.length > 76 ? firstMessage.slice(0, 76) + '…' : firstMessage}</strong><span>{conversation.updatedAt ? new Date(conversation.updatedAt).toLocaleString() : 'Saved conversation'}</span></button><span className={'support-conversation-status ' + conversation.status}>{conversation.status === 'needs_human' ? 'Needs human' : conversation.status === 'resolved' ? 'Resolved' : 'Open'}</span>{conversation.status === 'needs_human' ? <button type="button" className="support-small-action" onClick={() => void updateSupportConversationStatus(conversation.id, 'resolved')} disabled={supportStatusBusy === conversation.id}>Mark resolved</button> : <button type="button" className="support-small-action" onClick={() => void updateSupportConversationStatus(conversation.id, 'needs_human')} disabled={supportStatusBusy === conversation.id}>Request human</button>}</article>; })}</div> : <p className="empty-state">Customer test conversations will appear here after the first message.</p>}
              </div>
            </> : <div className="automation-note"><Sparkles size={17} /><div><strong>Next step</strong><p>Save this assistant first. You can then test its answers and review conversation history. Create another assistant whenever you need a separate business knowledge base.</p></div></div>}
            {supportNotice && <div className="automation-note"><CheckCircle2 size={17} /><div><strong>Support workspace</strong><p>{supportNotice}</p></div></div>}
            {supportError && <div className="error-message" role="alert">{supportError}</div>}
            <div className="automation-note"><Sparkles size={17} /><div><strong>Customer channels not connected yet</strong><p>This update provides private owner management and test conversations. Public website chat and WhatsApp still require a customer-facing widget, official WhatsApp Cloud API authorization, a verified webhook and a human contact route. Do not advertise these channels as live until they are tested.</p></div></div>
          </>}
        </section>}

        {activeTab === 'business' && <section className="studio-page business-page">
          <div className="studio-heading"><div className="studio-icon"><BriefcaseBusiness size={22} /></div><div><div className="eyebrow">DAVIMTH OPERATIONS</div><h1>Business Hub</h1><p>One control centre for your businesses, work and future ventures.</p></div></div>
          {!user ? <div className="business-signin">
            <div className="business-signin-icon"><Building2 size={28} /></div>
            <h2>Your private business workspace</h2>
            <p>Sign in to save business records and tasks securely to your account. Only your signed-in account can access its workspace.</p>
            {authError && <div className="error-message" role="alert">{authError}</div>}
            <button className="primary-action" onClick={signIn} disabled={authLoading}>{authLoading ? 'Checking sign-in...' : <><LogIn size={17} /> Sign in to continue</>}</button>
          </div> : <>
            <div className="business-welcome"><div><span className="plan-label">OWNER WORKSPACE</span><h2>{user.name || user.email || 'Welcome back'}</h2><p>DAVIMART · DAVITECH · Future businesses</p></div><button className="refresh-button" onClick={() => void loadWorkspace()} disabled={workspaceLoading}><RefreshCw size={15} /> Refresh</button></div>
            <div className="business-stats">
              <div className="business-stat"><Building2 size={18} /><strong>{businesses.length}</strong><span>Businesses</span></div>
              <div className="business-stat"><ClipboardList size={18} /><strong>{tasks.length}</strong><span>Total tasks</span></div>
              <div className="business-stat"><CircleCheck size={18} /><strong>{tasks.filter(task => task.status === 'done').length}</strong><span>Completed</span></div>
            </div>
            <div className="business-columns">
              <div className="business-panel"><div className="panel-heading"><h2>Your businesses</h2><span>Manage your portfolio</span></div>
                {workspaceLoading && records.length === 0 ? <p className="empty-state">Loading your workspace...</p> : businesses.length ? <div className="business-list">{businesses.map(item => <article className="business-item" key={item.id}><div className="business-item-icon"><Building2 size={18} /></div><div><strong>{item.title}</strong><p>{item.detail || 'Business workspace'}</p></div><span className="active-label">Added</span></article>)}</div> : <p className="empty-state">Your businesses will appear here.</p>}
              </div>
              <div className="business-panel"><div className="panel-heading"><h2>Add to your workspace</h2><span>Create a business or task</span></div>
                <form className="record-form" onSubmit={saveRecord}>
                  <div className="record-type-switch"><button type="button" className={recordKind === 'task' ? 'active' : ''} onClick={() => setRecordKind('task')}>New task</button><button type="button" className={recordKind === 'business' ? 'active' : ''} onClick={() => setRecordKind('business')}>New business</button></div>
                  <label htmlFor="record-title">{recordKind === 'business' ? 'Business name' : 'Task title'}</label>
                  <input id="record-title" value={recordTitle} onChange={event => setRecordTitle(event.target.value)} placeholder={recordKind === 'business' ? 'e.g. DAVORA Studios' : 'e.g. Reply to customer enquiries'} maxLength={100} />
                  {recordKind === 'task' && <><label htmlFor="record-business">Business</label><select id="record-business" value={recordBusiness} onChange={event => setRecordBusiness(event.target.value)}>{businesses.map(item => <option key={item.id} value={item.title}>{item.title}</option>)}{!businesses.length && <option value="General">General</option>}</select></>}
                  <label htmlFor="record-detail">Notes (optional)</label>
                  <textarea id="record-detail" value={recordDetail} onChange={event => setRecordDetail(event.target.value)} placeholder="Add useful details..." rows={3} maxLength={1000} />
                  <button className="primary-action" type="submit" disabled={savingRecord}>{savingRecord ? 'Saving...' : <><Plus size={16} /> Save {recordKind}</>}</button>
                </form>
              </div>
            </div>
            <div className="business-panel task-panel"><div className="panel-heading"><h2>Business task board</h2><span>Mark work complete as you go</span></div>
              {tasks.length ? <div className="task-list">{tasks.map(task => <article className={`task-item ${task.status === 'done' ? 'task-done' : ''}`} key={task.id}><button className="task-check" onClick={() => void updateTaskStatus(task)} aria-label={task.status === 'done' ? 'Reopen task' : 'Complete task'}>{task.status === 'done' ? <Check size={16} /> : <Clock3 size={16} />}</button><div className="task-copy"><strong>{task.title}</strong><p>{task.businessName}{task.detail ? ' · ' + task.detail : ''}</p></div><span className={task.status === 'done' ? 'done-label' : 'open-label'}>{task.status === 'done' ? 'Completed' : 'Open'}</span></article>)}</div> : <p className="empty-state">No tasks yet. Add your first task above.</p>}
            </div>
            <div className="automation-note"><Sparkles size={17} /><div><strong>Automation foundation</strong><p>This first workspace version saves your businesses and task board. Automatic customer messaging, order syncing, payment connections and vendor workflows still need their respective accounts and integrations. DAVImth will not move money or send sensitive messages without your approval.</p></div></div>
            {workspaceError && <div className="error-message" role="alert">{workspaceError}</div>}
          </>}
        </section>}

        {activeTab === 'image' && <section className="studio-page">
          <div className="studio-heading"><div className="studio-icon"><ImagePlus size={22} /></div><div><div className="eyebrow">DAVIMTH CREATIVE</div><h1>AI Image Creator</h1><p>Turn your imagination into an image.</p></div></div>
          <div className="plan-card"><div><span className="plan-label">YOUR PLAN</span><h2>Free plan</h2><p>One image generation each day on this browser.</p></div><div className="quota"><strong>{imagesLeft}/1</strong><span>free image left today</span></div></div>
          <form className="image-form" onSubmit={createImage}>
            <label htmlFor="image-prompt">Describe the image you want</label>
            <textarea id="image-prompt" value={imagePrompt} onChange={event => { setImagePrompt(event.target.value); setImageError(''); }} placeholder="Example: A photorealistic product advertisement for a premium wristwatch on a dark studio table, cinematic lighting..." rows={4} maxLength={1200} />
            <div className="form-hint">Be specific about the subject, setting, lighting and style.</div>
            {imageError && <div className="error-message" role="alert">{imageError}</div>}
            <button className="primary-action" type="submit" disabled={imageBusy || imagesLeft < 1}>{imageBusy ? <><span className="spinner" /> Creating your image...</> : <><Sparkles size={17} /> Create free image</>}</button>
            <p className="plan-note"><Check size={14} /> No payment is requested from free-plan users. Fair-use limits apply.</p>
          </form>
          {generatedImage && <div className="generated-result"><div className="result-heading"><h2>Your creation</h2><a href={generatedImage} download="davimth-ai-image.png"><Download size={15} /> Download image</a></div><img src={generatedImage} alt="AI-generated result" /></div>}
          <div className="studio-footnote">Free allowance is currently tracked on this browser and may reset if browser data is cleared. Image generation uses shared platform resources and is subject to fair-use limits.</div>
        </section>}

        {activeTab === 'video' && <section className="studio-page">
          <div className="studio-heading"><div className="studio-icon"><Video size={22} /></div><div><div className="eyebrow">DAVIMTH CREATIVE</div><h1>AI Video Studio</h1><p>Create moving scenes from words or pictures.</p></div></div>
          <div className="video-method-grid">
            <article className="video-method"><div className="studio-icon"><Sparkles size={20} /></div><h2>Text to video</h2><p>Describe a scene and turn your prompt into a realistic video.</p><span className="coming-soon">Coming soon</span></article>
            <article className="video-method"><div className="studio-icon"><ImagePlus size={20} /></div><h2>Image to video</h2><p>Upload a picture and bring it to life with motion.</p><span className="coming-soon">Coming soon</span></article>
          </div>
          <p className="studio-footnote">We are preparing the video provider connection and will show any generation cost before a video is created.</p>
        </section>}
      </main>
    </div>
  );
}
export default App;
