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
    
    // Status polling still needed for online/offline check
    const statusInterval = setInterval(checkStatus, 5000);

    // SSE for CPU usage updates (Push Architecture)
    const eventSource = new EventSource('/api/stats/stream');
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.id === id.toString()) {
          setCpuUsage(data.cpu_usage);
        }
      } catch (e) {
        console.error("Failed to parse SSE data", e);
      }
    };

    return () => {
      clearInterval(statusInterval);
      eventSource.close();
    };
  }, [id]);

  const checkStatus = async () => {
    try {
      const res = await fetch(`/api/status/${id}`);
      const data = await res.json();
      setStatus(data.status);
      // setCpuUsage is now primarily handled by SSE, 
      // but we update it here once on mount/check for consistency
      if (data.cpu_usage !== undefined) {
        setCpuUsage(data.cpu_usage);
      }
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

  const [ws, setWs] = useState<WebSocket | null>(null);
  const [pendingRequests, setPendingRequests] = useState<Record<string, (data: any) => void>>({});

  useEffect(() => {
    const socket = new WebSocket(`ws://${window.location.host}`);
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.chatId !== undefined && pendingRequests[data.chatId]) {
        pendingRequests[data.chatId](data);
      }
    };
    setWs(socket);
    return () => socket.close();
  }, [pendingRequests]);

  const generateResponse = async (chatbotIndex: number, prompt: string) => {
    if (!autoRunRef.current || !ws) return;
    
    setChatbots(prev => prev.map((cb, i) => i === chatbotIndex ? { ...cb, isGenerating: true } : cb));
    const userMsgId = Date.now().toString() + chatbotIndex;
    setChatbots(prev => prev.map((cb, i) => i === chatbotIndex ? { 
      ...cb, 
      messages: [...cb.messages, { id: userMsgId, role: 'user', content: prompt }].slice(-5) 
    } : cb));

    // Map prompt to ID based on index
    // The prompts.json structure is { "1": { "0": [...] }, ... }
    // chatbotIndex in `generateResponse` corresponds to the workerIndex
    // We need to map `chatbotIndex` to the correct category and group
    // In prompts.json: 
    // Legal(1) is category 1. workerIndex 0 is group 0.
    const promptId = `${id}:${chatbotIndex}:0`; // Simplified mapping for now, based on your structure

    return new Promise<void>((resolve) => {
      const chatbotId = (id - 1) * 5 + chatbotIndex + 1;
      
      setPendingRequests(prev => ({
        ...prev,
        [chatbotId]: (data: any) => {
          if (data.token) {
            setChatbots(prev => prev.map((cb, i) => i === chatbotIndex ? {
              ...cb,
              messages: cb.messages.map((m, msgIdx) => 
                msgIdx === cb.messages.length - 1 && m.role === 'assistant' 
                  ? { ...m, content: m.content + data.token }
                  : m
              ).length === cb.messages.length && cb.messages[cb.messages.length - 1].role === 'user'
                  ? [...cb.messages, { id: (Date.now() + 1).toString(), role: 'assistant', content: data.token }]
                  : cb.messages.map((m, msgIdx) => 
                      msgIdx === cb.messages.length - 1 && m.role === 'assistant' 
                        ? { ...m, content: m.content + data.token }
                        : m
                    )
            } : cb));
          } else if (data.error) {
            console.error(data.error);
            resolve();
          }
        }
      }));

      ws.send(JSON.stringify({ 
        chatId: chatbotId,
        promptId
      }));
      
      // Resolve after some timeout or completion signal
      setTimeout(resolve, 5000); // Simple timeout for demonstration
    });
  };

  const runWorker = async (workerIndex: number) => {
    // Independent loop for each worker to eliminate "bursting" and keep CPU busy
    while (autoRunRef.current) {
      const cb = chatbotsRef.current[workerIndex];
      const chatbotPrompts = PROMPTS_PER_INSTANCE[id][workerIndex];
      
      if (cb.currentPromptIndex >= chatbotPrompts.length) break;
      
      const prompt = chatbotPrompts[cb.currentPromptIndex];
      await generateResponse(workerIndex, prompt);
      
      if (!autoRunRef.current) break;

      // Update index for this specific worker immediately
      setChatbots(prev => {
        const next = prev.map((c, i) => i === workerIndex ? { ...c, currentPromptIndex: c.currentPromptIndex + 1 } : c);
        
        // If this was the last prompt for ALL workers in this instance, stop the auto-run
        const allFinished = next.every(c => c.currentPromptIndex >= PROMPTS_PER_INSTANCE[id][c.id].length);
        if (allFinished) {
          setIsAutoRunning(false);
        }
        return next;
      });

      // No artificial delay (like setTimeout 100ms) to ensure maximum CPU throughput
      // Tiny yield to event loop to keep UI responsive
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };

  useEffect(() => {
    if (isAutoRunning) {
      // Launch all workers independently rather than in a synchronized batch
      [0, 1, 2, 3, 4].forEach(index => runWorker(index));
    }
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
            {cpuUsage}%
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
    <div className="min-h-screen bg-[#09090b] text-zinc-100 font-sans p-4 md:p-6 selection:bg-indigo-500/30 flex flex-col">
      <div className="max-w-[1800px] w-full mx-auto flex flex-col flex-1">
        {/* Compact Unified Header Strip */}
        <header className="flex flex-col lg:flex-row items-center justify-between gap-6 bg-[#121214] border border-zinc-800/80 p-4 rounded-2xl mb-8 shadow-2xl relative overflow-hidden group">
          <div className="absolute inset-0 bg-indigo-500/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></div>
          
          {/* Brand Left */}
          <div className="flex items-center gap-6 shrink-0">
            <div className="relative shrink-0">
              <img src="/ampere-logo-dark.png" alt="Ampere Logo" className="h-8 w-auto object-contain" />
            </div>
            <div className="flex flex-col">
              <h1 className="text-lg font-black tracking-tighter text-white uppercase leading-none mb-1">
                LLM <span className="italic" style={{ color: '#F83821' }}>Orchestrator</span>
              </h1>
              <p className="text-[10px] text-zinc-500 font-bold tracking-widest uppercase whitespace-nowrap">
                Powered by AmpereOne® M CPUs
              </p>
            </div>
          </div>

          {/* Metrics Center */}
          <div className="flex flex-col items-center flex-1">
            <div className="text-[9px] text-zinc-600 font-black uppercase tracking-[0.4em] mb-3 opacity-50">
              High Density Enterprise Inference
            </div>
            <div className="flex items-center gap-8 justify-center w-full px-8">
              <div className="flex flex-col items-center">
                <div className="flex items-center gap-1.5 text-[9px] font-black text-indigo-400 uppercase tracking-[0.2em] mb-1">
                  <Zap size={10} className="fill-indigo-400" />
                  Real-time
                </div>
                <div className="text-3xl font-black text-white font-mono tabular-nums leading-none">
                  {totalTPS.toFixed(1)} <span className="text-[10px] text-zinc-600 font-bold ml-1">TPS</span>
                </div>
              </div>
              <div className="h-8 w-px bg-zinc-800"></div>
              <div className="flex flex-col items-center">
                <div className="flex items-center gap-1.5 text-[9px] font-black text-zinc-500 uppercase tracking-[0.2em] mb-1">
                  <ChevronRight size={10} className="text-indigo-500" />
                  Session Peak
                </div>
                <div className="text-3xl font-black text-zinc-400 font-mono tabular-nums leading-none">
                  {peakTPS.toFixed(1)} <span className="text-[10px] text-zinc-700 font-bold ml-1">TPS</span>
                </div>
              </div>
            </div>
          </div>

          {/* Controls Right */}
          <div className="flex items-center gap-6 shrink-0">
            <div className="flex flex-col items-end">
              <div className="flex items-center gap-1.5 text-[9px] font-black text-zinc-500 uppercase tracking-[0.2em] mb-1">
                <Activity size={10} className="text-emerald-500" />
                Cluster
              </div>
              <span className="text-[10px] font-mono text-emerald-400 font-bold uppercase tracking-widest">Optimal</span>
            </div>
            <button
              onClick={handleToggleAll}
              className={`flex items-center gap-3 px-8 py-3 rounded-xl font-black uppercase tracking-widest text-xs transition-all shadow-lg active:scale-[0.96] ${
                anyRunning 
                  ? 'bg-red-950/20 text-red-500 border border-red-500/50 hover:bg-red-500 hover:text-white' 
                  : 'bg-indigo-600 text-white hover:bg-indigo-500 hover:shadow-indigo-500/20'
              }`}
            >
              {anyRunning ? <Square size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
              <span>{anyRunning ? 'Stop' : 'Start'}</span>
            </button>
          </div>
        </header>

        <main className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 flex-1">
          <ChatbotInstance ref={instanceRefs[0]} id={1} name="Legal & Compliance Expert" port={8080} onRunningChange={(r) => handleRunningChange(0, r)} onTPSChange={(tps) => handleTPSChange(0, tps)} />
          <ChatbotInstance ref={instanceRefs[1]} id={2} name="Cybersecurity Expert" port={8081} onRunningChange={(r) => handleRunningChange(1, r)} onTPSChange={(tps) => handleTPSChange(1, tps)} />
          <ChatbotInstance ref={instanceRefs[2]} id={3} name="Fintech & Finance Expert" port={8082} onRunningChange={(r) => handleRunningChange(2, r)} onTPSChange={(tps) => handleTPSChange(2, tps)} />
          <ChatbotInstance ref={instanceRefs[3]} id={4} name="Supply Chain & Ops Expert" port={8083} onRunningChange={(r) => handleRunningChange(3, r)} onTPSChange={(tps) => handleTPSChange(3, tps)} />
        </main>

        <footer className="mt-12 border-t border-zinc-800/50 pt-8 flex items-center justify-between text-zinc-700">
          <div className="text-[9px] uppercase tracking-[0.3em] font-bold">
            © 2026 Ampere Computing LLC
          </div>
          <div className="flex items-center gap-4">
            <span className="text-[9px] font-mono">Build v3.4.2-A1</span>
            <div className="h-3 w-px bg-zinc-800"></div>
            <span className="text-[9px] font-black uppercase tracking-widest text-zinc-600">Production Ready</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
