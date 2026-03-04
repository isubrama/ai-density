import React, { useState, useEffect, useRef } from 'react';
import { Bot, User, Play, Square, Activity, Cpu, Server, Zap, Clock } from 'lucide-react';

const PROMPTS = [
  "Explain the theory of relativity in simple terms.",
  "Write a short poem about a robot learning to love.",
  "What are the main differences between classical and quantum computing?",
  "Describe a futuristic city powered entirely by renewable energy.",
  "How does a large language model work?"
];

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
  const [messages, setMessages] = useState<Message[]>([]);
  const [isAutoRunning, setIsAutoRunning] = useState(false);
  const [status, setStatus] = useState<'online' | 'offline' | 'checking'>('checking');
  const [currentPromptIndex, setCurrentPromptIndex] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [metrics, setMetrics] = useState({
    totalTokens: 0,
    avgTokensPerSecond: 0,
    requestsCompleted: 0
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const autoRunRef = useRef(isAutoRunning);

  useEffect(() => {
    autoRunRef.current = isAutoRunning;
  }, [isAutoRunning]);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 10000);
    return () => clearInterval(interval);
  }, [id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const checkStatus = async () => {
    try {
      const res = await fetch(`/api/status/${id}`);
      const data = await res.json();
      setStatus(data.status);
    } catch (e) {
      setStatus('offline');
    }
  };

  const generateResponse = async (prompt: string) => {
    setIsGenerating(true);
    const userMsgId = Date.now().toString();
    setMessages(prev => [...prev, { id: userMsgId, role: 'user', content: prompt }]);

    try {
      const res = await fetch(`/api/chat/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });

      if (!res.ok) throw new Error('Failed to generate');
      
      const data = await res.json();
      
      const evalCount = data.tokens_predicted || 0;
      const evalDuration = (data.timings?.predicted_ms || 0) * 1e6; // convert ms to ns
      const totalDuration = ((data.timings?.predicted_ms || 0) + (data.timings?.prompt_ms || 0)) * 1e6;
      const tokensPerSecond = data.timings?.predicted_per_second || 0;

      const assistantMsgId = (Date.now() + 1).toString();
      setMessages(prev => [...prev, {
        id: assistantMsgId,
        role: 'assistant',
        content: data.content,
        metrics: {
          evalCount,
          evalDuration,
          tokensPerSecond,
          totalDuration
        }
      }]);

      setMetrics(prev => {
        const newTotalTokens = prev.totalTokens + evalCount;
        const newRequests = prev.requestsCompleted + 1;
        const newAvg = prev.avgTokensPerSecond === 0 
          ? tokensPerSecond 
          : ((prev.avgTokensPerSecond * prev.requestsCompleted) + tokensPerSecond) / newRequests;
        
        return {
          totalTokens: newTotalTokens,
          avgTokensPerSecond: newAvg,
          requestsCompleted: newRequests
        };
      });

    } catch (error) {
      console.error(error);
      setMessages(prev => [...prev, { 
        id: Date.now().toString(), 
        role: 'assistant', 
        content: `Error connecting to llama.cpp instance ${id}. Make sure it is running.` 
      }]);
      setIsAutoRunning(false);
    } finally {
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    const runCycle = async () => {
      if (!autoRunRef.current || isGenerating) return;

      const prompt = PROMPTS[currentPromptIndex];
      await generateResponse(prompt);
      
      setCurrentPromptIndex(prev => (prev + 1) % PROMPTS.length);

      if (autoRunRef.current) {
        timeoutId = setTimeout(runCycle, 5000); // Wait 5s before next prompt
      }
    };

    if (isAutoRunning && !isGenerating) {
      runCycle();
    }

    return () => clearTimeout(timeoutId);
  }, [isAutoRunning, isGenerating, currentPromptIndex]);

  const toggleAutoRun = () => {
    setIsAutoRunning(!isAutoRunning);
  };

  return (
    <div className="bg-[#141414] border border-white/10 rounded-2xl flex flex-col h-[600px] overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-white/10 bg-[#1a1a1a] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Server className="w-5 h-5 text-emerald-400" />
          <div>
            <h2 className="font-medium text-sm">{name}</h2>
            <div className="flex items-center gap-2 mt-1">
              <div className={`w-2 h-2 rounded-full ${status === 'online' ? 'bg-emerald-500' : status === 'checking' ? 'bg-yellow-500' : 'bg-red-500'}`}></div>
              <span className="text-[10px] uppercase tracking-wider font-mono text-gray-400">{status}</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider">Avg Speed</div>
            <div className="text-xs font-mono text-emerald-400">{metrics.avgTokensPerSecond.toFixed(1)} t/s</div>
          </div>
          <button
            onClick={toggleAutoRun}
            disabled={status !== 'online'}
            className={`p-2 rounded-lg transition-all ${
              isAutoRunning 
                ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20' 
                : 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
            title={isAutoRunning ? "Stop Auto-Prompt" : "Start Auto-Prompt"}
          >
            {isAutoRunning ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
          </button>
        </div>
      </div>
      
      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-500 space-y-3">
            <Bot className="w-8 h-8 opacity-20" />
            <p className="text-sm text-center">Click play to start inference.</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.role === 'assistant' && (
                <div className="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0 border border-emerald-500/30 mt-1">
                  <Bot className="w-3 h-3 text-emerald-400" />
                </div>
              )}
              
              <div className={`max-w-[85%] flex flex-col gap-1.5 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div className={`p-3 rounded-2xl ${
                  msg.role === 'user' 
                    ? 'bg-white/10 text-white rounded-tr-sm' 
                    : 'bg-black/50 border border-white/5 rounded-tl-sm'
                }`}>
                  <p className="text-xs leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                </div>
                
                {msg.metrics && (
                  <div className="flex flex-wrap gap-2 text-[10px] font-mono text-gray-500 px-1">
                    <span className="flex items-center gap-1">
                      <Zap className="w-3 h-3 text-emerald-500/70" />
                      {msg.metrics.tokensPerSecond.toFixed(1)} t/s
                    </span>
                    <span className="flex items-center gap-1">
                      <Activity className="w-3 h-3" />
                      {msg.metrics.evalCount} tkns
                    </span>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
        {isGenerating && (
          <div className="flex items-center gap-2 text-[10px] font-mono text-emerald-400 p-2">
            <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></span>
            GENERATING
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-gray-100 font-sans p-4 md:p-6">
      <div className="max-w-[1600px] mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <Cpu className="w-8 h-8 text-emerald-400" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Ampere Density Cluster</h1>
            <p className="text-gray-400 text-sm">4x Independent Qwen3-8B-GGUF Instances</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 md:gap-6">
          <ChatbotInstance id={1} name="Instance 1 (Port 8080)" />
          <ChatbotInstance id={2} name="Instance 2 (Port 8081)" />
          <ChatbotInstance id={3} name="Instance 3 (Port 8082)" />
          <ChatbotInstance id={4} name="Instance 4 (Port 8083)" />
        </div>
      </div>
    </div>
  );
}
