import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Bot, User, Play, Square, Activity, Cpu, Server, Zap, Clock } from 'lucide-react';
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
  
  // 5 chatbots per instance
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
    const interval = setInterval(checkStatus, 10000);
    return () => clearInterval(interval);
  }, [id]);

  const checkStatus = async () => {
    try {
      const res = await fetch(`/api/status/${id}`);
      const data = await res.json();
      setStatus(data.status);
    } catch (e) {
      setStatus('offline');
    }
  };

  const fetchModel = async () => {
    try {
      const res = await fetch(`/api/models/${id}`);
      const data = await res.json();
      
      let modelInfo = '';
      
      // Exhaustive check for various API formats
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
      } else if (typeof data === 'string') {
        modelInfo = data;
      }

      if (modelInfo && typeof modelInfo === 'string') {
        const modelName = modelInfo.split('/').pop() || modelInfo;
        setModel(modelName);
      } else if (modelInfo && typeof modelInfo === 'object') {
        // Handle cases where it's still an object
        const maybeName = (modelInfo as any).id || (modelInfo as any).name || 'Unknown';
        setModel(String(maybeName).split('/').pop() || String(maybeName));
      } else {
        setModel('Unknown');
      }
    } catch (e) {
      console.error('Error fetching model:', e);
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
      if (error.name === 'AbortError') {
        return;
      }
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

    if (isAutoRunning) {
      runCycle();
    }

    return () => clearTimeout(timeoutId);
  }, [isAutoRunning, id]);

  return (
    <div className="bg-white border border-zinc-200 rounded-xl shadow-sm flex flex-col h-[1100px] overflow-hidden">
      <div className="p-4 border-b border-zinc-100 bg-zinc-50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="https://user-images.githubusercontent.com/1991296/230134379-7181e485-c521-4d23-a0d6-f7b3b61ba524.png" alt="llama.cpp" className="w-16 h-16 object-contain" referrerPolicy="no-referrer" />
          <div className="flex flex-col">
            <h2 className="font-semibold text-sm text-zinc-900 truncate leading-tight">{name}</h2>
            <div className="flex flex-col gap-1 mt-1">
              <span className="text-[9px] text-zinc-400 font-mono uppercase tracking-tighter">Port: {port}</span>
              <span className="text-[10px] text-zinc-500 font-mono bg-zinc-200 px-1.5 py-0.5 rounded border border-zinc-300 w-fit">Model: {model}</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 ml-auto self-start mt-1">
            <div className={`w-2 h-2 rounded-full ${status === 'online' ? 'bg-emerald-500' : status === 'checking' ? 'bg-yellow-500' : 'bg-red-500'}`}></div>
            <span className="text-[10px] font-semibold text-zinc-500 uppercase">{status}</span>
          </div>
        </div>
      </div>
      
      <div className="px-4 py-2 bg-zinc-100 text-[10px] font-mono text-zinc-600 border-b border-zinc-200 flex justify-between items-center">
        <span>Throughput</span>
        <span className="font-bold text-zinc-900">{chatbots.reduce((acc, cb) => acc + cb.metrics.avgTokensPerSecond, 0).toFixed(2)} TPS</span>
      </div>
      
      <div className="flex-1 flex flex-col gap-2 p-2 overflow-y-auto">
        {chatbots.map((cb, index) => (
          <div key={index} className="border border-zinc-100 rounded-lg flex flex-col overflow-hidden bg-zinc-50 h-[180px]">
            <div className="p-2 border-b border-zinc-100 text-[10px] font-semibold text-zinc-500 uppercase bg-zinc-100 flex justify-between items-center">
              <span>Chatbot {index + 1}</span>
              {cb.isGenerating && <span className="text-[8px] bg-emerald-100 text-emerald-700 px-1 rounded animate-pulse">Processing</span>}
            </div>
            <div className="flex flex-col flex-1 overflow-hidden">
              <div ref={el => promptRefs.current[index] = el} className="h-12 border-b border-zinc-100 overflow-y-auto p-2">
                <div className="text-[9px] font-bold text-zinc-400 uppercase mb-1">Prompts</div>
                {cb.messages.filter(m => m.role === 'user').map(msg => (
                  <div key={msg.id} className="text-xs bg-zinc-200 p-1.5 rounded mb-1">{msg.content}</div>
                ))}
              </div>
              <div ref={el => messageRefs.current[index] = el} className="flex-1 overflow-y-auto p-2">
                <div className="text-[9px] font-bold text-zinc-400 uppercase mb-1">Output</div>
                {cb.messages.filter(m => m.role === 'assistant').map(msg => (
                  <div key={msg.id} className="text-xs bg-white p-1.5 rounded border border-zinc-100 mb-1 flex flex-col gap-0.5">
                    <div>{msg.content}</div>
                    {msg.metrics && (
                      <div className="text-[8px] font-mono text-zinc-400">
                        {msg.metrics.tokensPerSecond.toFixed(2)} TPS
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
  const instanceRefs = [
    useRef<any>(null),
    useRef<any>(null),
    useRef<any>(null),
    useRef<any>(null)
  ];

  const [runningStates, setRunningStates] = useState([false, false, false, false]);
  const [tpsStates, setTpsStates] = useState([0, 0, 0, 0]);
  const [peakTPS, setPeakTPS] = useState(0);
  
  const anyRunning = runningStates.some(r => r);
  const totalTPS = tpsStates.reduce((acc, tps) => acc + tps, 0);

  useEffect(() => {
    if (totalTPS > peakTPS) {
      setPeakTPS(totalTPS);
    }
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
    if (anyRunning) {
      instanceRefs.forEach(ref => ref.current?.stop());
    } else {
      instanceRefs.forEach(ref => ref.current?.start());
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 font-sans p-4 md:p-6">
      <div className="max-w-[1600px] mx-auto">
        <div className="flex flex-col items-center mb-12">
          <div className="flex flex-row items-center gap-8 mb-6">
            <img src="https://upload.wikimedia.org/wikipedia/commons/f/f4/Ampere_Computing_LLC_Logo.svg" alt="Ampere Computing Logo" className="w-48 h-48 object-contain" referrerPolicy="no-referrer" />
            <div>
              <h1 className="text-4xl font-bold tracking-tight text-zinc-900 mb-2">High-Density LLM Orchestration on Ampere CPUs</h1>
              <p className="text-zinc-500 text-lg">High-throughput inference across multi-instance compute clusters.</p>
            </div>
          </div>
          
          <div className="flex items-center gap-6 bg-white p-4 rounded-2xl border border-zinc-200 shadow-sm mb-8">
            <div className="flex flex-col items-center px-6 border-r border-zinc-100">
              <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider mb-1">Cluster Throughput</span>
              <span className="text-3xl font-black text-zinc-900 font-mono">{totalTPS.toFixed(2)} <span className="text-sm font-normal text-zinc-500">TPS</span></span>
            </div>
            <div className="flex flex-col items-center px-6 border-r border-zinc-100">
              <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider mb-1">Peak Throughput</span>
              <span className="text-3xl font-black text-zinc-900 font-mono">{peakTPS.toFixed(2)} <span className="text-sm font-normal text-zinc-500">TPS</span></span>
            </div>
            <button
              onClick={handleToggleAll}
              className={`flex items-center gap-2 px-8 py-4 rounded-xl font-bold transition-all shadow-lg active:scale-95 ${
                anyRunning ? 'bg-red-50 text-red-600 hover:bg-red-100' : 'bg-zinc-900 text-white hover:bg-zinc-800'
              }`}
            >
              {anyRunning ? <Square size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
              {anyRunning ? 'Stop All Instances' : 'Run All Instances'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <ChatbotInstance ref={instanceRefs[0]} id={1} name="Legal & Compliance Expert" port={8080} onRunningChange={(r) => handleRunningChange(0, r)} onTPSChange={(tps) => handleTPSChange(0, tps)} />
          <ChatbotInstance ref={instanceRefs[1]} id={2} name="Cybersecurity Expert" port={8081} onRunningChange={(r) => handleRunningChange(1, r)} onTPSChange={(tps) => handleTPSChange(1, tps)} />
          <ChatbotInstance ref={instanceRefs[2]} id={3} name="Fintech & Finance Expert" port={8082} onRunningChange={(r) => handleRunningChange(2, r)} onTPSChange={(tps) => handleTPSChange(2, tps)} />
          <ChatbotInstance ref={instanceRefs[3]} id={4} name="Supply Chain & Ops Expert" port={8083} onRunningChange={(r) => handleRunningChange(3, r)} onTPSChange={(tps) => handleTPSChange(3, tps)} />
        </div>
      </div>
    </div>
  );
}
