import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Bot, User, Play, Square, Activity, Cpu, Server, Zap, Clock, Shield, Scale, Wallet, Truck, BarChart3, ChevronRight } from 'lucide-react';
import prompts from './prompts.json';

const PROMPTS_PER_INSTANCE: Record<number, Record<number, string[]>> = prompts as any;

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  metrics?: {
    evalCount: number;
    evalDuration: number;
    tokensPerSecond: number;
    totalDuration: number;
  };
}

const ChatbotInstance = forwardRef<any, { id: number, name: string, port: number, onRunningChange?: (running: boolean) => void, onTPSChange?: (tps: number) => void }>(({ id, name, port, onRunningChange, onTPSChange }, ref) => {
  const [isAutoRunning, setIsAutoRunning] = useState(false);
  const [status, setStatus] = useState<'online' | 'offline' | 'checking'>('checking');
  const [model, setModel] = useState<string>('Loading...');
  const [cpuUsage, setCpuUsage] = useState(0);
  
  const [chatbots, setChatbots] = useState(Array.from({ length: 5 }, (_, i) => ({
    id: i,
    messages: [] as Message[],
    currentPromptIndex: 0,
    isGenerating: false,
    metrics: { totalTokens: 0, avgTokensPerSecond: 0, requestsCompleted: 0 }
  })));

  const messageRefs = useRef<(HTMLDivElement | null)[]>(Array(5).fill(null));
  const promptRefs = useRef<(HTMLDivElement | null)[]>(Array(5).fill(null));
  const chatbotsRef = useRef(chatbots);
  useEffect(() => { chatbotsRef.current = chatbots; }, [chatbots]);

  const autoRunRef = useRef(isAutoRunning);
  useEffect(() => { 
    autoRunRef.current = isAutoRunning;
    onRunningChange?.(isAutoRunning);
  }, [isAutoRunning, onRunningChange]);

  const abortControllerRef = useRef<AbortController | null>(null);

  useImperativeHandle(ref, () => ({
    start: () => {
      if (status === 'online' && !isAutoRunning) {
        abortControllerRef.current = new AbortController();
        setChatbots(prev => prev.map(cb => ({ ...cb, currentPromptIndex: 0, messages: [], isGenerating: false })));
        setIsAutoRunning(true);
      }
    },
    stop: () => {
      setIsAutoRunning(false);
      abortControllerRef.current?.abort();
    },
    isAutoRunning,
    status
  }));

  useEffect(() => {
    chatbots.forEach((cb, index) => {
      if (messageRefs.current[index]) {
        messageRefs.current[index]!.scrollTop = messageRefs.current[index]!.scrollHeight;
      }
      if (promptRefs.current[index]) {
        promptRefs.current[index]!.scrollTop = promptRefs.current[index]!.scrollHeight;
      }
    });
    
    const instanceTPS = chatbots.reduce((acc, cb) => acc + cb.metrics.avgTokensPerSecond, 0);
    onTPSChange?.(instanceTPS);
  }, [chatbots, onTPSChange]);

  useEffect(() => {
    checkStatus();
    fetchModel();
    const interval = setInterval(checkStatus, 5000);
    return () => clearInterval(interval);
  }, [id]);

  const checkStatus = async () => {
    try {
      const res = await fetch(`/api/status/${id}`);
      const data = await res.json();
      setStatus(data.status);
      setCpuUsage(data.cpu_usage || 0);
    } catch (e) {
      setStatus('offline');
      setCpuUsage(0);
    }
  };

  const fetchModel = async () => {
    try {
      const res = await fetch(`/api/models/${id}`);
      const data = await res.json();
      
      let modelInfo = '';
      if (data.models && data.models.length > 0) {
        modelInfo = data.models[0].id || data.models[0].name || data.models[0];
      } else if (data.data && Array.isArray(data.data) && data.data.length > 0) {
        modelInfo = data.data[0].id || data.data[0].name || data.data[0];
      } else if (data.default_generation_settings?.model) {
        modelInfo = data.default_generation_settings.model;
      } else if (data.model_path) {
        modelInfo = data.model_path;
      } else if (data.model) {
        modelInfo = data.model;
      }

      if (modelInfo && typeof modelInfo === 'string') {
        const modelName = modelInfo.split('/').pop() || modelInfo;
        setModel(modelName);
      } else {
        setModel('Unknown');
      }
    } catch (e) {
      setModel('Unknown');
    }
  };

  const generateResponse = async (chatbotIndex: number, prompt: string) => {
    if (!autoRunRef.current) return;
    
    setChatbots(prev => prev.map((cb, i) => i === chatbotIndex ? { ...cb, isGenerating: true } : cb));
    const userMsgId = Date.now().toString() + chatbotIndex;
    setChatbots(prev => prev.map((cb, i) => i === chatbotIndex ? { ...cb, messages: [...cb.messages, { id: userMsgId, role: 'user', content: prompt }] } : cb));

    try {
      const res = await fetch(`/api/chat/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal: abortControllerRef.current?.signal
      });

      if (!res.ok) throw new Error('Failed to generate');
      
      const data = await res.json();
      
      if (!autoRunRef.current) return;

      const evalCount = data.tokens_predicted || 0;
      const tokensPerSecond = data.timings?.predicted_per_second || 0;

      const assistantMsgId = (Date.now() + 1).toString() + chatbotIndex;
      setChatbots(prev => prev.map((cb, i) => i === chatbotIndex ? { 
        ...cb, 
        messages: [...cb.messages, {
          id: assistantMsgId,
          role: 'assistant',
          content: data.content,
          metrics: {
            evalCount,
            evalDuration: (data.timings?.predicted_ms || 0) * 1e6,
            tokensPerSecond,
            totalDuration: ((data.timings?.predicted_ms || 0) + (data.timings?.prompt_ms || 0)) * 1e6
          }
        }],
        metrics: {
          totalTokens: cb.metrics.totalTokens + evalCount,
          requestsCompleted: cb.metrics.requestsCompleted + 1,
          avgTokensPerSecond: cb.metrics.avgTokensPerSecond === 0 
            ? tokensPerSecond 
            : ((cb.metrics.avgTokensPerSecond * cb.metrics.requestsCompleted) + tokensPerSecond) / (cb.metrics.requestsCompleted + 1)
        }
      } : cb));

    } catch (error: any) {
      if (error.name === 'AbortError') return;
      console.error(error);
      setChatbots(prev => prev.map((cb, i) => i === chatbotIndex ? { 
        ...cb, 
        messages: [...cb.messages, { 
          id: Date.now().toString(), 
          role: 'assistant', 
          content: `Error connecting to llama.cpp instance ${id}.` 
        }]
      } : cb));
    } finally {
      setChatbots(prev => prev.map((cb, i) => i === chatbotIndex ? { ...cb, isGenerating: false } : cb));
    }
  };

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    const runCycle = async () => {
      if (!autoRunRef.current) return;

      const promises = chatbotsRef.current.map(async (cb, index) => {
        const chatbotPrompts = PROMPTS_PER_INSTANCE[id][index];
        if (cb.isGenerating || cb.currentPromptIndex >= chatbotPrompts.length) return;
        
        const prompt = chatbotPrompts[cb.currentPromptIndex];
        await generateResponse(index, prompt);
        
        if (!autoRunRef.current) return;

        setChatbots(prev => prev.map((c, i) => i === index ? { ...c, currentPromptIndex: c.currentPromptIndex + 1 } : c));
      });

      await Promise.all(promises);

      if (autoRunRef.current && chatbotsRef.current.some(cb => cb.currentPromptIndex < PROMPTS_PER_INSTANCE[id][cb.id].length)) {
        timeoutId = setTimeout(runCycle, 1000);
      } else {
        setIsAutoRunning(false);
      }
    };

    if (isAutoRunning) runCycle();
    return () => clearTimeout(timeoutId);
  }, [isAutoRunning, id]);

  const getInstanceIcon = () => {
    if (name.includes('Legal')) return <Scale size={18} className="text-indigo-400" />;
    if (name.includes('Cybersecurity')) return <Shield size={18} className="text-indigo-400" />;
    if (name.includes('Fintech')) return <Wallet size={18} className="text-indigo-400" />;
    if (name.includes('Supply Chain')) return <Truck size={18} className="text-indigo-400" />;
    return <Cpu size={18} className="text-indigo-400" />;
  };

  return (
    <div className="bg-[#121214] border border-zinc-800/50 rounded-2xl shadow-xl flex flex-col h-[1050px] overflow-hidden transition-all hover:border-zinc-700/80 group">
      <div className="p-5 border-b border-zinc-800/80 bg-[#161618]/50 flex items-center justify-between">
        <div className="flex items-center gap-4 overflow-hidden">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 group-hover:bg-indigo-500/20 transition-all shrink-0">
            {getInstanceIcon()}
          </div>
          <div className="flex flex-col overflow-hidden">
            <h2 className="font-bold text-sm text-zinc-100 tracking-tight leading-none mb-1.5 truncate">{name}</h2>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-indigo-300 font-mono truncate leading-tight" title={model}>
                <span className="text-zinc-600 mr-1">Model:</span>{model}
              </span>
              <span className="text-[8px] text-zinc-500 font-mono uppercase tracking-widest border border-zinc-800/50 px-1 py-0.5 rounded bg-zinc-900/30 w-fit">Port: {port}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0 ml-2">
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${status === 'online' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : status === 'checking' ? 'bg-amber-500' : 'bg-red-500'}`}></div>
            <span className="text-[9px] font-bold text-zinc-400 uppercase tracking-tighter">{status}</span>
          </div>
        </div>
      </div>
      
      <div className="px-5 py-3 bg-[#161618] border-b border-zinc-800 flex flex-col gap-2.5">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2 text-[10px] text-zinc-400 uppercase tracking-widest font-bold">
            <Cpu size={10} className="text-indigo-500" />
            <span>CPU Load</span>
          </div>
          <span className={`font-black text-[10px] font-mono ${cpuUsage > 80 ? 'text-rose-500' : cpuUsage > 40 ? 'text-amber-500' : 'text-emerald-500'}`}>
            {cpuUsage.toFixed(1)}%
          </span>
        </div>
        <div className="w-full h-1 bg-zinc-900 rounded-full overflow-hidden border border-zinc-800/50">
          <div 
            className={`h-full transition-all duration-1000 ease-out rounded-full ${cpuUsage > 80 ? 'bg-rose-500' : cpuUsage > 40 ? 'bg-amber-500' : 'bg-emerald-500'}`}
            style={{ width: `${cpuUsage}%` }}
          ></div>
        </div>
        <div className="flex justify-between items-center mt-1">
          <div className="flex items-center gap-2 text-[10px] text-zinc-400 uppercase tracking-widest font-bold">
            <Zap size={10} className="text-indigo-500" />
            <span>Throughput</span>
          </div>
          <span className="font-black text-xs text-zinc-100 font-mono bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800">
            {chatbots.reduce((acc, cb) => acc + cb.metrics.avgTokensPerSecond, 0).toFixed(2)} <span className="text-[9px] font-normal text-zinc-500 ml-0.5">TPS</span>
          </span>
        </div>
      </div>
      
      <div className="flex-1 flex flex-col gap-3 p-3 overflow-y-auto custom-scrollbar">
        {chatbots.map((cb, index) => (
          <div key={index} className="border border-zinc-800/40 rounded-xl flex flex-col overflow-hidden bg-[#18181b]/50 h-[175px] transition-all hover:bg-[#18181b] hover:border-zinc-700/50">
            <div className="px-3 py-1.5 border-b border-zinc-800/40 text-[9px] font-black text-zinc-500 uppercase bg-zinc-900/40 flex justify-between items-center">
              <span className="tracking-widest">Worker {index + 1}</span>
              {cb.isGenerating && (
                <div className="flex items-center gap-1.5">
                  <span className="w-1 h-1 rounded-full bg-indigo-500 animate-ping"></span>
                  <span className="text-[8px] text-indigo-400 lowercase tracking-normal">inferencing...</span>
                </div>
              )}
            </div>
            <div className="flex flex-col flex-1 overflow-hidden">
              <div ref={el => promptRefs.current[index] = el} className="h-10 border-b border-zinc-800/30 overflow-y-auto p-2 bg-zinc-900/20">
                {cb.messages.filter(m => m.role === 'user').slice(-1).map(msg => (
                  <div key={msg.id} className="text-[11px] text-zinc-400 italic flex gap-1.5">
                    <User size={10} className="mt-0.5 text-zinc-600 shrink-0" />
                    <span className="truncate" title={msg.content}>{msg.content}</span>
                  </div>
                ))}
              </div>
              <div ref={el => messageRefs.current[index] = el} className="flex-1 overflow-y-auto p-2.5 space-y-2 bg-[#121214]/50 custom-scrollbar">
                {cb.messages.filter(m => m.role === 'assistant').map(msg => (
                  <div key={msg.id} className="text-[11px] leading-relaxed text-zinc-200 bg-[#1c1c1f] p-2 rounded-lg border border-zinc-800/50 relative group/msg shadow-sm">
                    <div className="flex items-start gap-2">
                      <Bot size={12} className="mt-0.5 text-indigo-400 shrink-0" />
                      <div>{msg.content}</div>
                    </div>
                    {msg.metrics && (
                      <div className="absolute top-1 right-2 text-[8px] font-mono text-indigo-500/60 opacity-0 group-hover/msg:opacity-100 transition-all">
                        {msg.metrics.tokensPerSecond.toFixed(1)} t/s
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

export default function App() {
  const instanceRefs = [useRef<any>(null), useRef<any>(null), useRef<any>(null), useRef<any>(null)];
  const [runningStates, setRunningStates] = useState([false, false, false, false]);
  const [tpsStates, setTpsStates] = useState([0, 0, 0, 0]);
  const [peakTPS, setPeakTPS] = useState(0);
  
  const anyRunning = runningStates.some(r => r);
  const totalTPS = tpsStates.reduce((acc, tps) => acc + tps, 0);

  useEffect(() => {
    if (totalTPS > peakTPS) setPeakTPS(totalTPS);
  }, [totalTPS, peakTPS]);

  const handleRunningChange = (index: number, running: boolean) => {
    setRunningStates(prev => {
      const next = [...prev];
      next[index] = running;
      return next;
    });
  };

  const handleTPSChange = (index: number, tps: number) => {
    setTpsStates(prev => {
      const next = [...prev];
      next[index] = tps;
      return next;
    });
  };

  const handleToggleAll = () => {
    if (anyRunning) instanceRefs.forEach(ref => ref.current?.stop());
    else instanceRefs.forEach(ref => ref.current?.start());
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 font-sans p-4 md:p-8 selection:bg-indigo-500/30">
      <div className="max-w-[1700px] mx-auto">
        <header className="flex flex-col md:flex-row items-center justify-between mb-16 gap-8 border-b border-zinc-800/50 pb-12">
          <div className="flex items-center gap-10">
            <div className="relative">
              <div className="absolute inset-0 bg-indigo-500 blur-[80px] opacity-20 animate-pulse"></div>
              <img 
                src="https://upload.wikimedia.org/wikipedia/commons/f/f4/Ampere_Computing_LLC_Logo.svg" 
                alt="Ampere Logo" 
                className="w-48 h-12 relative grayscale brightness-200"
              />
            </div>
            <div className="h-12 w-px bg-zinc-800 hidden md:block"></div>
            <div className="flex flex-col">
              <h1 className="text-3xl font-black tracking-tight text-white mb-2 uppercase">
                LLM <span className="text-indigo-500 italic">Orchestrator</span>
              </h1>
              <p className="text-zinc-500 text-sm font-medium tracking-wide">
                High-Density Enterprise Inference <span className="text-zinc-700 mx-2">|</span> Powered by AmpereOne® M CPUs
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
             <div className="flex flex-col items-end mr-6">
                <div className="flex items-center gap-2 text-[10px] text-zinc-500 font-bold uppercase tracking-[0.2em] mb-1">
                  <Activity size={10} className="text-indigo-500" />
                  Cluster Health
                </div>
                <div className="text-sm font-mono text-emerald-400 flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
                  SYSTEMS OPTIMAL
                </div>
             </div>
          </div>
        </header>

        <section className="mb-12 relative overflow-hidden bg-[#121214] rounded-3xl border border-zinc-800/80 p-8 shadow-2xl">
          <div className="absolute top-0 right-0 p-8 opacity-5">
            <BarChart3 size={120} className="text-indigo-500" />
          </div>
          
          <div className="flex flex-col md:flex-row items-center justify-between gap-12 relative z-10">
            <div className="grid grid-cols-2 gap-12 flex-1 max-w-2xl">
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2 text-[11px] font-black text-indigo-400 uppercase tracking-[0.3em]">
                  <Zap size={12} className="fill-indigo-400" />
                  Real-time Throughput
                </div>
                <div className="flex items-baseline gap-3">
                  <span className="text-6xl font-black text-white font-mono tabular-nums leading-none tracking-tighter">
                    {totalTPS.toFixed(1)}
                  </span>
                  <span className="text-lg font-bold text-zinc-600 uppercase">Tokens / Sec</span>
                </div>
              </div>
              
              <div className="flex flex-col gap-3 border-l border-zinc-800 pl-12">
                <div className="flex items-center gap-2 text-[11px] font-black text-zinc-500 uppercase tracking-[0.3em]">
                  <ChevronRight size={12} className="text-indigo-500" />
                  Session Peak
                </div>
                <div className="flex items-baseline gap-3">
                  <span className="text-6xl font-black text-zinc-300 font-mono tabular-nums leading-none tracking-tighter">
                    {peakTPS.toFixed(1)}
                  </span>
                  <span className="text-lg font-bold text-zinc-700 uppercase">TPS</span>
                </div>
              </div>
            </div>

            <button
              onClick={handleToggleAll}
              className={`group relative flex items-center justify-center gap-4 px-12 py-5 rounded-2xl font-black uppercase tracking-widest transition-all shadow-[0_20px_40px_-12px_rgba(0,0,0,0.5)] active:scale-[0.98] ${
                anyRunning 
                  ? 'bg-red-950/20 text-red-500 border border-red-500/50 hover:bg-red-500 hover:text-white' 
                  : 'bg-indigo-600 text-white hover:bg-indigo-500 hover:-translate-y-1 hover:shadow-indigo-500/20'
              }`}
            >
              {anyRunning ? <Square size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
              <span className="text-lg">{anyRunning ? 'Stop Cluster' : 'Start Cluster'}</span>
              <div className={`absolute -inset-1 rounded-[18px] opacity-0 blur group-hover:opacity-30 transition-all ${anyRunning ? 'bg-red-500' : 'bg-indigo-500'}`}></div>
            </button>
          </div>
        </section>

        <main className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <ChatbotInstance ref={instanceRefs[0]} id={1} name="Legal & Compliance Expert" port={8080} onRunningChange={(r) => handleRunningChange(0, r)} onTPSChange={(tps) => handleTPSChange(0, tps)} />
          <ChatbotInstance ref={instanceRefs[1]} id={2} name="Cybersecurity Expert" port={8081} onRunningChange={(r) => handleRunningChange(1, r)} onTPSChange={(tps) => handleTPSChange(1, tps)} />
          <ChatbotInstance ref={instanceRefs[2]} id={3} name="Fintech & Finance Expert" port={8082} onRunningChange={(r) => handleRunningChange(2, r)} onTPSChange={(tps) => handleTPSChange(2, tps)} />
          <ChatbotInstance ref={instanceRefs[3]} id={4} name="Supply Chain & Ops Expert" port={8083} onRunningChange={(r) => handleRunningChange(3, r)} onTPSChange={(tps) => handleTPSChange(3, tps)} />
        </main>

        <footer className="mt-20 border-t border-zinc-800/50 pt-10 text-center">
          <div className="inline-flex items-center gap-3 bg-[#121214] px-6 py-2 rounded-full border border-zinc-800 shadow-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500"></span>
            <span className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em]">Deployment State: Production Grade</span>
            <span className="text-zinc-700 mx-2">|</span>
            <span className="text-[10px] text-zinc-600 font-mono">Build v3.4.2-A1</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
