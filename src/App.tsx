import React, { useState, useEffect, useRef, useCallback } from 'react';
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

function ChatbotInstance({ id, name }: { id: number, name: string }) {
  const [isAutoRunning, setIsAutoRunning] = useState(false);
  const [status, setStatus] = useState<'online' | 'offline' | 'checking'>('checking');
  
  // 5 chatbots per instance
  const [chatbots, setChatbots] = useState(Array.from({ length: 5 }, (_, i) => ({
    id: i,
    messages: [] as Message[],
    currentPromptIndex: 0,
    isGenerating: false,
    metrics: { totalTokens: 0, avgTokensPerSecond: 0, requestsCompleted: 0 }
  })));

  const abortControllers = useRef<(AbortController | null)[]>(Array(5).fill(null));

  const messageRefs = useRef<(HTMLDivElement | null)[]>(Array(5).fill(null));
  const promptRefs = useRef<(HTMLDivElement | null)[]>(Array(5).fill(null));

  useEffect(() => {
    chatbots.forEach((cb, index) => {
      if (messageRefs.current[index]) {
        messageRefs.current[index]!.scrollTop = messageRefs.current[index]!.scrollHeight;
      }
      if (promptRefs.current[index]) {
        promptRefs.current[index]!.scrollTop = promptRefs.current[index]!.scrollHeight;
      }
    });
  }, [chatbots]);

  const autoRunRef = useRef(isAutoRunning);
  useEffect(() => { autoRunRef.current = isAutoRunning; }, [isAutoRunning]);

  useEffect(() => {
    checkStatus();
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

  const generateResponse = useCallback(async (chatbotIndex: number, prompt: string, signal: AbortSignal) => {
    setChatbots(prev => prev.map((cb, i) => i === chatbotIndex ? { ...cb, isGenerating: true } : cb));
    const userMsgId = Date.now().toString() + chatbotIndex;
    setChatbots(prev => prev.map((cb, i) => i === chatbotIndex ? { ...cb, messages: [...cb.messages, { id: userMsgId, role: 'user', content: prompt }] } : cb));

    try {
      const res = await fetch(`/api/chat/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal
      });

      if (!res.ok) throw new Error('Failed to generate');
      
      const data = await res.json();
      
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

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('Generation aborted');
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
  }, [id]);

  useEffect(() => {
    if (!isAutoRunning) {
      abortControllers.current.forEach(controller => controller?.abort());
      abortControllers.current = Array(5).fill(null);
      return;
    }

    chatbots.forEach((cb, index) => {
      if (!cb.isGenerating && cb.currentPromptIndex < PROMPTS_PER_INSTANCE[id][index].length) {
        const controller = new AbortController();
        abortControllers.current[index] = controller;
        
        generateResponse(index, PROMPTS_PER_INSTANCE[id][index][cb.currentPromptIndex], controller.signal).then(() => {
          setChatbots(prev => prev.map((c, i) => i === index ? { ...c, currentPromptIndex: c.currentPromptIndex + 1 } : c));
        });
      }
    });
  }, [isAutoRunning, chatbots, id, generateResponse]);

  const toggleAutoRun = () => {
    if (!isAutoRunning) {
      // Starting a new run, reset indices and messages
      setChatbots(prev => prev.map(cb => ({ ...cb, currentPromptIndex: 0, messages: [] })));
    }
    setIsAutoRunning(!isAutoRunning);
  };

  return (
    <div className="bg-white border border-zinc-200 rounded-xl shadow-sm flex flex-col h-[1100px] overflow-hidden">
      <div className="p-4 border-b border-zinc-100 bg-zinc-50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="https://user-images.githubusercontent.com/1991296/230134379-7181e485-c521-4d23-a0d6-f7b3b61ba524.png" alt="llama.cpp" className="w-20 h-20 object-contain" referrerPolicy="no-referrer" />
          <h2 className="font-semibold text-sm text-zinc-900 truncate">{name}</h2>
          <div className="flex items-center gap-1.5 ml-auto">
            <div className={`w-2 h-2 rounded-full ${status === 'online' ? 'bg-emerald-500' : status === 'checking' ? 'bg-yellow-500' : 'bg-red-500'}`}></div>
            <span className="text-[10px] font-semibold text-zinc-500 uppercase">{status}</span>
          </div>
        </div>
        <button
          onClick={toggleAutoRun}
          disabled={status !== 'online'}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
            isAutoRunning ? 'bg-red-50 text-red-600' : 'bg-zinc-900 text-white'
          }`}
        >
          {isAutoRunning ? 'Stop' : 'Run'}
        </button>
      </div>
      
      <div className="px-4 py-2 bg-zinc-100 text-[10px] font-mono text-zinc-600 border-b border-zinc-200">
        Aggregate Performance: {chatbots.reduce((acc, cb) => acc + cb.metrics.avgTokensPerSecond, 0).toFixed(2)} TPS
      </div>
      
      <div className="flex-1 flex flex-col gap-2 p-2 overflow-y-auto">
        {chatbots.map((cb, index) => (
          <div key={index} className="border border-zinc-100 rounded-lg flex flex-col overflow-hidden bg-zinc-50 h-[180px]">
            <div className="p-2 border-b border-zinc-100 text-[10px] font-semibold text-zinc-500 uppercase bg-zinc-100">Chatbot {index + 1}</div>
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
}

export default function App() {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 font-sans p-4 md:p-6">
      <div className="max-w-[1600px] mx-auto">
        <div className="flex justify-center mb-12">
          <div className="flex flex-row items-center gap-8">
            <img src="https://upload.wikimedia.org/wikipedia/commons/f/f4/Ampere_Computing_LLC_Logo.svg" alt="Ampere Computing Logo" className="w-48 h-48 object-contain" referrerPolicy="no-referrer" />
            <div>
              <h1 className="text-4xl font-bold tracking-tight text-zinc-900 mb-2">High-Density LLM Orchestration on Ampere CPUs</h1>
              <p className="text-zinc-500 text-lg">High-throughput inference across multi-instance compute clusters.</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <ChatbotInstance id={1} name="1 (8080)" />
          <ChatbotInstance id={2} name="2 (8081)" />
          <ChatbotInstance id={3} name="3 (8082)" />
          <ChatbotInstance id={4} name="4 (8083)" />
        </div>
      </div>
    </div>
  );
}
