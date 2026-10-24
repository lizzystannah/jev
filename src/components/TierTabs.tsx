import React from 'react';
import { SlipTier } from '../types.js';

interface TierTabsProps {
  tier: SlipTier;
  counts: Record<SlipTier, number>;
  onChange: (tier: SlipTier) => void;
  className?: string;
}

const TIERS: Array<{ id: SlipTier; label: string; color: string }> = [
  { id: 'segura', label: 'Segura', color: '#4FAE73' },
  { id: 'moderada', label: 'Moderada', color: '#E7B33E' },
  { id: 'ousada', label: 'Ousada', color: '#D1594B' },
  { id: 'maluca', label: 'Maluca', color: '#C084FC' },
];

export const TierTabs: React.FC<TierTabsProps> = ({ tier, counts, onChange, className = '' }) => {
  return (
    <div
      className={`flex flex-wrap gap-x-5 gap-y-1 border-b border-[rgba(245,243,236,0.14)] ${className}`}
      role="tablist"
      aria-label="Categorias de probabilidade"
    >
      {TIERS.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onChange(item.id)}
          className={`cursor-pointer font-body font-semibold text-sm pb-2.5 mr-6 relative transition-colors ${
            tier === item.id
              ? 'text-[#F5F3EC]'
              : 'text-[rgba(245,243,236,0.45)] hover:text-[#F5F3EC]'
          }`}
        >
          <span>{item.label}</span>
          <span className="font-display ml-1.5 text-xs" style={{ color: item.color }}>
            {counts[item.id]}
          </span>
          {tier === item.id && (
            <span
              className="absolute left-0 right-0 bottom-[-1px] h-[2px]"
              style={{ backgroundColor: item.color }}
            />
          )}
        </button>
      ))}
    </div>
  );
};
