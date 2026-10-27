import React from 'react';
import { LayoutGrid, SlidersHorizontal, Cpu, Bot } from 'lucide-react';

export type EngineTab = 'principal' | 'manual' | 'jev' | 'automacao';

interface EngineTabsProps {
  active: EngineTab;
  onChange: (tab: EngineTab) => void;
  counts?: Record<EngineTab, number>;
}

const TABS: Array<{ id: EngineTab; label: string; icon: React.ReactNode }> = [
  { id: 'principal', label: 'Principal', icon: <LayoutGrid className="w-3.5 h-3.5" /> },
  { id: 'manual', label: 'Manual', icon: <SlidersHorizontal className="w-3.5 h-3.5" /> },
  { id: 'jev', label: 'JEV', icon: <Cpu className="w-3.5 h-3.5" /> },
  { id: 'automacao', label: 'Automação', icon: <Bot className="w-3.5 h-3.5" /> },
];

export const EngineTabs: React.FC<EngineTabsProps> = ({ active, onChange, counts }) => {
  return (
    <div className="max-w-[1180px] w-full mx-auto px-4 sm:px-6 pt-6">
      <div
        className="inline-flex items-center gap-1 rounded-lg border border-[rgba(245,243,236,0.14)] bg-[#0E2A1C] p-1"
        role="tablist"
        aria-label="Motor de bilhetes"
      >
        {TABS.map((tab) => {
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(tab.id)}
              className={`cursor-pointer inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                isActive
                  ? 'bg-[#20502F] text-[#F5F3EC] shadow-sm'
                  : 'text-[rgba(245,243,236,0.55)] hover:text-[#F5F3EC] hover:bg-[#173C27]'
              }`}
            >
              <span className={isActive ? 'text-[#E7B33E]' : 'text-[rgba(245,243,236,0.45)]'}>
                {tab.icon}
              </span>
              <span>{tab.label}</span>
              {counts && counts[tab.id] > 0 && (
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded ${
                    isActive ? 'bg-[#081C13] text-[#E7B33E]' : 'bg-[#173C27] text-[rgba(245,243,236,0.55)]'
                  }`}
                >
                  {counts[tab.id]}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
