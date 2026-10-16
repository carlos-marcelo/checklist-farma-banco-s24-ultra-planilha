import React, { useMemo, useState } from 'react';
import {
    Award,
    Check,
    ChevronDown,
    ChevronUp,
    Copy,
    ExternalLink,
    Filter,
    HelpCircle,
    Info,
    Medal,
    MessageSquare,
    Percent,
    RefreshCw,
    Search,
    Share2,
    ShieldAlert,
    ShieldCheck,
    Sparkles,
    Star,
    Store,
    TrendingDown,
    TrendingUp,
    Trophy,
    X,
    Gem,
    Clock
} from 'lucide-react';
import type { AuditCrossRow, AuditCrossStatus } from './AuditCrossPanel';
import { resolveBranchArea, resolveBranchCity } from '../../src/branchDirectory';

export type RankingSortCriterion = 'diffPct' | 'accuracy';

export type AuditRankingPanelProps = {
    rows: AuditCrossRow[];
    loading?: boolean;
    onRefresh?: () => void;
    onOpenAudit?: (row: AuditCrossRow) => void;
    expanded?: boolean;
    onToggleExpanded?: (expanded: boolean) => void;
};

export type PerformanceTier = 'diamond' | 'gold' | 'silver' | 'alert' | 'pending';

export type BranchRankingItem = {
    key: string;
    branch: string;
    area: string;
    city?: string;
    auditNumber: number;
    status: AuditCrossStatus;
    hasRealCount: boolean;
    countedCost: number;
    countedUnits: number;
    diffCost: number;
    diffQty: number;
    progressPct: number;
    accuracyPct: number;
    divergencePct: number;
    absDivPct: number;
    tier: PerformanceTier;
    tierLabel: string;
    tierEmoji: string;
    originalRow: AuditCrossRow;
};

const formatCurrency = (value: number) => {
    return Number(value || 0).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
};

const formatSignedCurrency = (value: number) => {
    const num = Number(value || 0);
    const sign = num > 0.009 ? '+' : '';
    return `${sign}${formatCurrency(num)}`;
};

const formatPercent = (value: number, decimals = 2) => {
    const num = Number(value || 0);
    return `${num.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}%`;
};

const formatSignedPercent = (value: number, decimals = 2) => {
    const num = Number(value || 0);
    const sign = num > 0.009 ? '+' : '';
    return `${sign}${formatPercent(num, decimals)}`;
};

// Classificação solicitada:
// - Lojas sem contagem real (> 0.01): Pendente / Aguardando contagem
// - Diamante 💎: abaixo de 0,10% (< 0.10%)
// - Ouro 🥇: abaixo de 0,30% (0.10% a 0.29%)
// - Prata 🥈: 0,30% a 0,49%
// - Alerta 🔴: acima de 0,50% (>= 0.50%)
const getPerformanceTier = (absDivPct: number, hasRealCount: boolean): {
    tier: PerformanceTier;
    label: string;
    emoji: string;
    badgeBg: string;
    textColor: string;
    borderColor: string;
} => {
    if (!hasRealCount) {
        return {
            tier: 'pending',
            label: 'Aguardando',
            emoji: '⏳',
            badgeBg: 'bg-slate-800 text-slate-400 border-slate-700',
            textColor: 'text-slate-400',
            borderColor: 'border-slate-800'
        };
    }

    const div = Math.abs(Number(absDivPct || 0));

    if (div < 0.10) {
        return {
            tier: 'diamond',
            label: 'Diamante',
            emoji: '💎',
            badgeBg: 'bg-cyan-500/15 text-cyan-300 border-cyan-400/40',
            textColor: 'text-cyan-300',
            borderColor: 'border-cyan-500/40'
        };
    }
    if (div < 0.30) {
        return {
            tier: 'gold',
            label: 'Ouro',
            emoji: '🥇',
            badgeBg: 'bg-amber-500/15 text-amber-300 border-amber-400/40',
            textColor: 'text-amber-300',
            borderColor: 'border-amber-500/40'
        };
    }
    if (div < 0.50) {
        return {
            tier: 'silver',
            label: 'Prata',
            emoji: '🥈',
            badgeBg: 'bg-slate-300/15 text-slate-200 border-slate-300/40',
            textColor: 'text-slate-300',
            borderColor: 'border-slate-400/40'
        };
    }
    return {
        tier: 'alert',
        label: 'Alerta',
        emoji: '🔴',
        badgeBg: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
        textColor: 'text-rose-300',
        borderColor: 'border-rose-500/40'
    };
};

const AuditRankingPanel: React.FC<AuditRankingPanelProps> = ({
    rows,
    loading = false,
    onRefresh,
    onOpenAudit,
    expanded: controlledExpanded,
    onToggleExpanded
}) => {
    const [internalExpanded, setInternalExpanded] = useState(false);
    const expanded = controlledExpanded !== undefined ? controlledExpanded : internalExpanded;
    const setExpanded = (nextVal: boolean | ((prev: boolean) => boolean)) => {
        const resolved = typeof nextVal === 'function' ? nextVal(expanded) : nextVal;
        setInternalExpanded(resolved);
        onToggleExpanded?.(resolved);
    };

    // Filtros: status, auditoria, área, busca e ordenação focada (apenas Divergência e Acurácia)
    const [statusFilter, setStatusFilter] = useState<'all' | AuditCrossStatus>('all');
    const [auditNumberFilter, setAuditNumberFilter] = useState<string>('all');
    const [areaFilter, setAreaFilter] = useState<string>('all');
    const [searchTerm, setSearchTerm] = useState<string>('');
    const [sortCriterion, setSortCriterion] = useState<RankingSortCriterion>('diffPct');
    const [showWhatsappModal, setShowWhatsappModal] = useState<boolean>(false);
    const [copiedWhatsapp, setCopiedWhatsapp] = useState<boolean>(false);

    // Lista única de auditorias e áreas disponíveis
    const availableAuditNumbers = useMemo(() => {
        const set = new Set<number>();
        rows.forEach(r => {
            if (r.auditNumber && r.auditNumber > 0) set.add(r.auditNumber);
        });
        return Array.from(set).sort((a, b) => b - a);
    }, [rows]);

    const availableAreas = useMemo(() => {
        const set = new Set<string>();
        rows.forEach(r => {
            const area = resolveBranchArea(r.branch, r.area);
            if (area && area.trim()) set.add(area.trim());
        });
        return Array.from(set).sort((a, b) => a.localeCompare(b, 'pt-BR'));
    }, [rows]);

    // Filtragem dos dados de acordo com seleção do usuário
    const filteredRows = useMemo(() => {
        return rows.filter(row => {
            const resolvedArea = resolveBranchArea(row.branch, row.area);
            const resolvedCity = resolveBranchCity(row.branch, row.city);

            // Filtro de status: Fechadas (completed), Abertas (open) ou Todas (all)
            if (statusFilter !== 'all' && row.status !== statusFilter) return false;
            // Filtro de número de auditoria
            if (auditNumberFilter !== 'all' && String(row.auditNumber) !== auditNumberFilter) return false;
            // Filtro de área
            if (areaFilter !== 'all' && resolvedArea !== areaFilter) return false;
            // Filtro de busca textual (filial ou cidade)
            if (searchTerm.trim()) {
                const term = searchTerm.trim().toLowerCase();
                const branchMatch = row.branch.toLowerCase().includes(term);
                const cityMatch = (resolvedCity || '').toLowerCase().includes(term);
                const areaMatch = (resolvedArea || '').toLowerCase().includes(term);
                if (!branchMatch && !cityMatch && !areaMatch) return false;
            }
            return true;
        });
    }, [rows, statusFilter, auditNumberFilter, areaFilter, searchTerm]);

    // Consolidação por Filial e Cálculo do Ranking
    const rankedItems = useMemo<BranchRankingItem[]>(() => {
        const map = new Map<string, {
            key: string;
            branch: string;
            area: string;
            city?: string;
            auditNumber: number;
            status: AuditCrossStatus;
            countedCost: number;
            countedUnits: number;
            diffCost: number;
            diffQty: number;
            divergencePct: number;
            progressPctSum: number;
            count: number;
            originalRow: AuditCrossRow;
        }>();

        filteredRows.forEach(row => {
            const resolvedArea = resolveBranchArea(row.branch, row.area);
            const resolvedCity = resolveBranchCity(row.branch, row.city);
            const key = statusFilter === 'all' && auditNumberFilter === 'all'
                ? row.branch // Agrupamento por loja para ranking geral consolidado
                : `${row.branch}_${row.auditNumber}_${row.status}`;

            // Busca do custo real da contagem
            const cost = Number(row.countedCost || (row as any).auditedBaseCost || (row as any).totalCost || 0);
            const diff = Number(row.diffCost || 0);
            const divPct = Number(row.divergencePct || 0);

            const existing = map.get(key);
            if (!existing) {
                map.set(key, {
                    key,
                    branch: row.branch,
                    area: resolvedArea,
                    city: resolvedCity,
                    auditNumber: row.auditNumber,
                    status: row.status,
                    countedCost: cost,
                    countedUnits: Number(row.countedUnits || 0),
                    diffCost: diff,
                    diffQty: Number(row.diffQty || 0),
                    divergencePct: divPct,
                    progressPctSum: Number(row.progressPct || 0),
                    count: 1,
                    originalRow: row
                });
            } else {
                existing.countedCost += cost;
                existing.countedUnits += Number(row.countedUnits || 0);
                existing.diffCost += diff;
                existing.diffQty += Number(row.diffQty || 0);
                existing.progressPctSum += Number(row.progressPct || 0);
                existing.count += 1;
            }
        });

        const items: BranchRankingItem[] = Array.from(map.values()).map(entry => {
            const cost = Math.abs(entry.countedCost);
            const diff = entry.diffCost;
            const hasRealCount = cost > 0.01;

            // Cálculo estritamente proporcional:
            // Divergência % = (diff / cost) * 100
            // Acurácia % = 100% - |Divergência %|
            let divPct = 0;
            if (hasRealCount) {
                divPct = (diff / cost) * 100;
            } else if (entry.divergencePct !== 0) {
                divPct = entry.divergencePct;
            }

            const absDivPct = hasRealCount ? Math.round(Math.abs(divPct) * 100) / 100 : 0;
            const accuracy = hasRealCount
                ? Math.max(0, Math.min(100, Math.round((100 - absDivPct) * 100) / 100))
                : 0;

            const tierInfo = getPerformanceTier(absDivPct, hasRealCount);

            return {
                key: entry.key,
                branch: entry.branch,
                area: entry.area,
                city: entry.city,
                auditNumber: entry.auditNumber,
                status: entry.status,
                hasRealCount,
                countedCost: Math.round(entry.countedCost * 100) / 100,
                countedUnits: entry.countedUnits,
                diffCost: Math.round(entry.diffCost * 100) / 100,
                diffQty: entry.diffQty,
                progressPct: Math.round(entry.progressPctSum / entry.count),
                accuracyPct: accuracy,
                divergencePct: Math.round(divPct * 100) / 100,
                absDivPct,
                tier: tierInfo.tier,
                tierLabel: tierInfo.label,
                tierEmoji: tierInfo.emoji,
                originalRow: entry.originalRow
            };
        });

        // Ordenação inteligente:
        // Lojas com contagem real SEMPRE vêm no topo!
        // - diffPct: menor divergência (mais próximo de 0%) primeiro
        // - accuracy: maior acurácia (mais próximo de 100%) primeiro
        items.sort((a, b) => {
            if (a.hasRealCount && !b.hasRealCount) return -1;
            if (!a.hasRealCount && b.hasRealCount) return 1;

            if (a.hasRealCount && b.hasRealCount) {
                if (sortCriterion === 'accuracy') {
                    if (b.accuracyPct !== a.accuracyPct) return b.accuracyPct - a.accuracyPct;
                    return a.absDivPct - b.absDivPct;
                }
                // default: menor divergência % (mais próximo de 0%)
                if (a.absDivPct !== b.absDivPct) return a.absDivPct - b.absDivPct;
                return Math.abs(a.diffCost) - Math.abs(b.diffCost);
            }

            return a.branch.localeCompare(b.branch, 'pt-BR');
        });

        return items;
    }, [filteredRows, statusFilter, auditNumberFilter, sortCriterion]);

    // Métricas Globais da Rede (Acurácia próxima a 100%, Divergência próxima a 0%)
    const networkSummary = useMemo(() => {
        const countedItems = rankedItems.filter(i => i.hasRealCount);
        const totalBranches = rankedItems.length;

        if (countedItems.length === 0) {
            return {
                totalBranches,
                countedBranches: 0,
                totalCost: 0,
                totalDiffCost: 0,
                totalUnits: 0,
                averageAccuracy: 100,
                averageDivPct: 0,
                absAverageDivPct: 0,
                diamondCount: 0,
                goldCount: 0,
                silverCount: 0,
                alertCount: 0,
                pendingCount: totalBranches
            };
        }

        const totalCost = countedItems.reduce((acc, item) => acc + item.countedCost, 0);
        const totalDiffCost = countedItems.reduce((acc, item) => acc + item.diffCost, 0);
        const totalUnits = countedItems.reduce((acc, item) => acc + item.countedUnits, 0);
        const averageDivPct = totalCost > 0 ? (totalDiffCost / totalCost) * 100 : 0;
        const absAverageDivPct = Math.abs(averageDivPct);
        const averageAccuracy = Math.max(0, 100 - absAverageDivPct);

        const diamondCount = countedItems.filter(i => i.tier === 'diamond').length;
        const goldCount = countedItems.filter(i => i.tier === 'gold').length;
        const silverCount = countedItems.filter(i => i.tier === 'silver').length;
        const alertCount = countedItems.filter(i => i.tier === 'alert').length;
        const pendingCount = rankedItems.filter(i => !i.hasRealCount).length;

        return {
            totalBranches,
            countedBranches: countedItems.length,
            totalCost: Math.round(totalCost * 100) / 100,
            totalDiffCost: Math.round(totalDiffCost * 100) / 100,
            totalUnits,
            averageAccuracy: Math.round(averageAccuracy * 100) / 100,
            averageDivPct: Math.round(averageDivPct * 100) / 100,
            absAverageDivPct: Math.round(absAverageDivPct * 100) / 100,
            diamondCount,
            goldCount,
            silverCount,
            alertCount,
            pendingCount
        };
    }, [rankedItems]);

    // Top 3 (Pódio de Lojas com Auditorias Reais)
    const podium = useMemo(() => {
        const valid = rankedItems.filter(i => i.hasRealCount);
        return {
            first: valid[0] || null,
            second: valid[1] || null,
            third: valid[2] || null
        };
    }, [rankedItems]);

    // Mensagem de WhatsApp Funcional
    const whatsappMessage = useMemo(() => {
        const now = new Date();
        const dateStr = now.toLocaleDateString('pt-BR');
        const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        const statusLabel = statusFilter === 'completed'
            ? 'FECHADAS'
            : statusFilter === 'open'
                ? 'ABERTAS'
                : 'TODAS AS LOJAS (CONSOLIDADO)';

        const auditLabel = auditNumberFilter !== 'all'
            ? ` | Aud. #${auditNumberFilter}`
            : '';

        const areaLabel = areaFilter !== 'all'
            ? ` | ${areaFilter}`
            : '';

        let text = `🏆 *RANKING DE AUDITORIA - CONTROLE DE ESTOQUE*\n`;
        text += `🏢 *DROGARIA CIDADE*\n`;
        text += `📅 _Emissão: ${dateStr} às ${timeStr}_\n`;
        text += `🎯 *Escopo:* ${statusLabel}${auditLabel}${areaLabel}\n`;
        text += `────────────────────────────\n`;
        text += `📊 *PANORAMA DA REDE:*\n`;
        text += `• Acurácia da Rede: *${formatPercent(networkSummary.averageAccuracy)}* (ideal: 100%)\n`;
        text += `• Divergência da Rede: *${formatSignedPercent(networkSummary.averageDivPct)}* (ideal: 0%)\n`;
        text += `• Saldo Financeiro: *${formatSignedCurrency(networkSummary.totalDiffCost)}*\n`;
        text += `• Estoque Auditado: *${formatCurrency(networkSummary.totalCost)}*\n`;
        text += `• Distribuição: 💎 ${networkSummary.diamondCount} Diamante | 🥇 ${networkSummary.goldCount} Ouro | 🥈 ${networkSummary.silverCount} Prata | 🔴 ${networkSummary.alertCount} Alerta\n`;
        text += `────────────────────────────\n`;
        text += `🥇 *TOP 3 DESTAQUES (AUDITORIAS REAIS):*\n\n`;

        if (podium.first) {
            text += `1º ${podium.first.tierEmoji} *${podium.first.branch}* (${podium.first.area})\n`;
            text += `   • Acurácia: *${formatPercent(podium.first.accuracyPct)}* | Div: *${formatSignedPercent(podium.first.divergencePct)}*\n`;
            text += `   • Saldo: ${formatSignedCurrency(podium.first.diffCost)} | Auditado: ${formatCurrency(podium.first.countedCost)}\n\n`;
        }
        if (podium.second) {
            text += `2º ${podium.second.tierEmoji} *${podium.second.branch}* (${podium.second.area})\n`;
            text += `   • Acurácia: *${formatPercent(podium.second.accuracyPct)}* | Div: *${formatSignedPercent(podium.second.divergencePct)}*\n`;
            text += `   • Saldo: ${formatSignedCurrency(podium.second.diffCost)} | Auditado: ${formatCurrency(podium.second.countedCost)}\n\n`;
        }
        if (podium.third) {
            text += `3º ${podium.third.tierEmoji} *${podium.third.branch}* (${podium.third.area})\n`;
            text += `   • Acurácia: *${formatPercent(podium.third.accuracyPct)}* | Div: *${formatSignedPercent(podium.third.divergencePct)}*\n`;
            text += `   • Saldo: ${formatSignedCurrency(podium.third.diffCost)} | Auditado: ${formatCurrency(podium.third.countedCost)}\n\n`;
        }

        if (rankedItems.length > 3) {
            text += `────────────────────────────\n`;
            text += `📋 *CLASSIFICAÇÃO GERAL:*\n`;
            rankedItems.slice(3).forEach((item, index) => {
                const pos = index + 4;
                if (item.hasRealCount) {
                    text += `${pos}º ${item.tierEmoji} *${item.branch}*: Acurácia ${formatPercent(item.accuracyPct)} | Div ${formatSignedPercent(item.divergencePct)} (${formatSignedCurrency(item.diffCost)})\n`;
                } else {
                    text += `${pos}º ⏳ *${item.branch}*: Aguardando contagem\n`;
                }
            });
        }

        text += `────────────────────────────\n`;
        text += `📌 *LEGENDA (DIVERGÊNCIA %):*\n`;
        text += `💎 Diamante: Abaixo de 0,10%\n`;
        text += `🥇 Ouro: Abaixo de 0,30%\n`;
        text += `🥈 Prata: 0,30% a 0,49%\n`;
        text += `🔴 Alerta: Acima de 0,50%\n`;
        text += `\n_AuditFlow - Sistema de Auditoria_`;

        return text;
    }, [statusFilter, auditNumberFilter, areaFilter, networkSummary, podium, rankedItems]);

    const handleCopyWhatsapp = async () => {
        try {
            await navigator.clipboard.writeText(whatsappMessage);
            setCopiedWhatsapp(true);
            setTimeout(() => setCopiedWhatsapp(false), 2500);
        } catch {
            const el = document.createElement('textarea');
            el.value = whatsappMessage;
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
            setCopiedWhatsapp(true);
            setTimeout(() => setCopiedWhatsapp(false), 2500);
        }
    };

    const handleOpenWhatsappWeb = () => {
        const encoded = encodeURIComponent(whatsappMessage);
        window.open(`https://api.whatsapp.com/send?text=${encoded}`, '_blank');
    };

    // MODO RECOLHIDO: Botão elegante
    if (!expanded) {
        return (
            <aside className="w-full xl:w-12 shrink-0 self-start">
                <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    className="group relative h-12 w-full xl:sticky xl:top-16 inline-flex items-center justify-center gap-2 rounded-lg border border-amber-500/30 bg-slate-950 px-3 text-amber-400 shadow-sm transition-all duration-200 hover:border-amber-400/70 hover:bg-amber-500/10 hover:text-amber-300 hover:scale-[1.03] cursor-pointer"
                    title="Abrir Ranking de Desempenho e Divergência"
                >
                    <Trophy className="h-5 w-5 shrink-0 transition-transform group-hover:rotate-6 text-amber-400" />
                    <span className="text-xs font-bold xl:hidden">Ranking de Auditoria</span>
                    <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[9px] font-black text-slate-950">
                        %
                    </span>
                </button>
            </aside>
        );
    }

    // MODO EXPANDIDO: Layout Adaptativo de Alta Fidelidade Visual
    return (
        <aside className="w-full lg:w-[380px] xl:w-[400px] 2xl:w-[420px] shrink-0 self-start animate-fade-in max-w-full">
            <div className="rounded-xl border border-slate-800 bg-slate-950/95 backdrop-blur-md shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
                
                {/* CABEÇALHO DO PAINEL */}
                <div className="p-4 border-b border-slate-800/80 bg-gradient-to-r from-slate-950 via-slate-900 to-amber-950/20">
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-500/30 bg-gradient-to-br from-amber-500/20 to-amber-600/10 text-amber-400 shadow-inner">
                                <Trophy className="h-5 w-5" />
                            </div>
                            <div>
                                <h2 className="text-sm font-black tracking-wide text-white">
                                    RANKING DE AUDITORIA
                                </h2>
                                <p className="text-[11px] font-medium text-slate-400 mt-0.5">
                                    Acurácia (100%) vs Divergência (0%)
                                </p>
                            </div>
                        </div>

                        {/* AÇÕES MANUAIS DE CABEÇALHO */}
                        <div className="flex items-center gap-1">
                            {onRefresh && (
                                <button
                                    type="button"
                                    onClick={onRefresh}
                                    disabled={loading}
                                    className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
                                    title="Atualizar dados manualmente"
                                >
                                    <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin text-amber-400' : ''}`} />
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => setExpanded(false)}
                                className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
                                title="Recolher painel"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                    </div>

                    {/* BOTÃO DISPARO WHATSAPP */}
                    <div className="mt-3">
                        <button
                            type="button"
                            onClick={() => setShowWhatsappModal(true)}
                            className="w-full flex items-center justify-center gap-2 rounded-lg bg-emerald-600/90 hover:bg-emerald-500 px-3 py-2 text-xs font-black text-white shadow-md transition-all hover:scale-[1.01] cursor-pointer"
                        >
                            <MessageSquare className="h-4 w-4" />
                            <span>Transformar em WhatsApp</span>
                        </button>
                    </div>

                    {/* LEGENDA EXPLICATIVA DE FAIXAS */}
                    <div className="mt-3 grid grid-cols-4 gap-1 p-2 rounded-lg border border-slate-800 bg-slate-900/80 text-[10px] text-center font-bold">
                        <div className="p-1 rounded bg-cyan-500/10 border border-cyan-500/30 text-cyan-300">
                            <div>💎 Diamante</div>
                            <div className="text-[9px] font-normal text-cyan-200/80">&lt; 0,10%</div>
                        </div>
                        <div className="p-1 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300">
                            <div>🥇 Ouro</div>
                            <div className="text-[9px] font-normal text-amber-200/80">&lt; 0,30%</div>
                        </div>
                        <div className="p-1 rounded bg-slate-400/10 border border-slate-400/30 text-slate-300">
                            <div>🥈 Prata</div>
                            <div className="text-[9px] font-normal text-slate-400">0,30 a 0,49%</div>
                        </div>
                        <div className="p-1 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300">
                            <div>🔴 Alerta</div>
                            <div className="text-[9px] font-normal text-rose-200/80">&gt; 0,50%</div>
                        </div>
                    </div>
                </div>

                {/* FILTROS DINÂMICOS */}
                <div className="p-3 border-b border-slate-800/80 bg-slate-900/60 space-y-2.5">
                    
                    {/* Status da Auditoria (Todas, Fechadas, Abertas) */}
                    <div className="flex items-center gap-1 rounded-lg bg-slate-950 p-1 border border-slate-800">
                        <button
                            type="button"
                            onClick={() => setStatusFilter('all')}
                            className={`flex-1 py-1.5 px-2 rounded-md text-[11px] font-black transition-all cursor-pointer ${statusFilter === 'all' ? 'bg-amber-500 text-slate-950 shadow' : 'text-slate-400 hover:text-white'}`}
                        >
                            Todas (Soma)
                        </button>
                        <button
                            type="button"
                            onClick={() => setStatusFilter('completed')}
                            className={`flex-1 py-1.5 px-2 rounded-md text-[11px] font-black transition-all cursor-pointer ${statusFilter === 'completed' ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                        >
                            Fechadas
                        </button>
                        <button
                            type="button"
                            onClick={() => setStatusFilter('open')}
                            className={`flex-1 py-1.5 px-2 rounded-md text-[11px] font-black transition-all cursor-pointer ${statusFilter === 'open' ? 'bg-cyan-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                        >
                            Abertas
                        </button>
                    </div>

                    {/* Seleção por Auditoria e Regional */}
                    <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1 block">
                                Auditoria
                            </label>
                            <select
                                value={auditNumberFilter}
                                onChange={(e) => setAuditNumberFilter(e.target.value)}
                                className="w-full rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-xs font-semibold text-slate-200 outline-none focus:border-amber-400/50"
                            >
                                <option value="all">Todas as Auditorias</option>
                                {availableAuditNumbers.map(num => (
                                    <option key={num} value={String(num)}>
                                        Auditoria #{num}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div>
                            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1 block">
                                Regional / Área
                            </label>
                            <select
                                value={areaFilter}
                                onChange={(e) => setAreaFilter(e.target.value)}
                                className="w-full rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-xs font-semibold text-slate-200 outline-none focus:border-amber-400/50"
                            >
                                <option value="all">Todas as Regionais</option>
                                {availableAreas.map(area => (
                                    <option key={area} value={area}>
                                        {area}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Ordenação (Focada exclusivamente em Divergência e Acurácia) e Busca */}
                    <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1 block">
                                Ordenar Ranking por
                            </label>
                            <select
                                value={sortCriterion}
                                onChange={(e) => setSortCriterion(e.target.value as RankingSortCriterion)}
                                className="w-full rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-xs font-semibold text-amber-300 outline-none focus:border-amber-400/50"
                            >
                                <option value="diffPct">📉 Menor Divergência % (0%)</option>
                                <option value="accuracy">🏆 Maior Acurácia % (100%)</option>
                            </select>
                        </div>

                        <div>
                            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1 block">
                                Buscar Loja
                            </label>
                            <div className="relative">
                                <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-500" />
                                <input
                                    type="text"
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    placeholder="Filial ou cidade..."
                                    className="w-full rounded-lg border border-slate-800 bg-slate-950 pl-8 pr-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-amber-400/50"
                                />
                            </div>
                        </div>
                    </div>
                </div>

                {/* PAINEL DE CONTEÚDO COM ROLAGEM */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">

                    {/* CARDS EXECUTIVOS DE TOPO: Acurácia (próxima a 100%) e Divergência (próxima a 0%) */}
                    <div className="grid grid-cols-2 gap-2">
                        <div className="p-3 rounded-xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-950/80">
                            <span className="text-[10px] font-black uppercase tracking-wider text-emerald-400 block">
                                Acurácia Geral Rede
                            </span>
                            <div className="mt-1 flex items-baseline gap-1.5">
                                <span className="text-2xl font-black text-emerald-400">
                                    {formatPercent(networkSummary.averageAccuracy)}
                                </span>
                                <span className="text-[9px] font-bold text-slate-500">
                                    (meta: 100%)
                                </span>
                            </div>
                            <div className="mt-1 flex items-center gap-1 text-[9px] text-slate-400 font-semibold truncate">
                                <span>💎 {networkSummary.diamondCount}</span>
                                <span>•</span>
                                <span>🥇 {networkSummary.goldCount}</span>
                                <span>•</span>
                                <span>🥈 {networkSummary.silverCount}</span>
                                <span>•</span>
                                <span>🔴 {networkSummary.alertCount}</span>
                            </div>
                        </div>

                        <div className="p-3 rounded-xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-950/80">
                            <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 block">
                                Divergência Total
                            </span>
                            <div className="mt-1 flex items-baseline gap-1.5">
                                <span className={`text-xl font-black ${networkSummary.absAverageDivPct < 0.30 ? 'text-emerald-400' : networkSummary.absAverageDivPct < 0.50 ? 'text-amber-400' : 'text-rose-400'}`}>
                                    {formatSignedPercent(networkSummary.averageDivPct)}
                                </span>
                                <span className="text-[9px] font-bold text-slate-500">
                                    (meta: 0%)
                                </span>
                            </div>
                            <div className="mt-1 text-[10px] font-bold text-slate-300 truncate">
                                Saldo: <span className={networkSummary.totalDiffCost < 0 ? 'text-rose-400' : networkSummary.totalDiffCost > 0 ? 'text-emerald-400' : 'text-slate-300'}>{formatSignedCurrency(networkSummary.totalDiffCost)}</span>
                            </div>
                        </div>
                    </div>

                    {/* PÓDIO DE DESTAQUE (AUDITORIAS REAIS) */}
                    {podium.first && (
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-[11px] font-black uppercase tracking-widest text-amber-400 flex items-center gap-1.5">
                                    <Medal className="h-3.5 w-3.5" /> Pódio de Excelência
                                </span>
                                <span className="text-[9px] font-bold text-slate-500">
                                    Auditorias Reais
                                </span>
                            </div>

                            <div className="grid grid-cols-3 gap-2">
                                
                                {/* 2º LUGAR */}
                                {podium.second ? (
                                    <div
                                        onClick={() => onOpenAudit && onOpenAudit(podium.second!.originalRow)}
                                        className="p-2.5 rounded-xl border border-slate-800 bg-slate-900/60 hover:bg-slate-800/80 hover:border-slate-700 transition-all cursor-pointer flex flex-col justify-between"
                                    >
                                        <div>
                                            <div className="flex items-center justify-between text-slate-400">
                                                <span className="text-xs font-black">2º</span>
                                                <span className="text-xs">{podium.second.tierEmoji}</span>
                                            </div>
                                            <p className="font-black text-xs text-white truncate mt-1">
                                                {podium.second.branch}
                                            </p>
                                            <p className="text-[9px] text-slate-400 truncate">{podium.second.area}</p>
                                        </div>
                                        <div className="mt-2 pt-2 border-t border-slate-800/80">
                                            <div className="text-xs font-black text-emerald-400">
                                                {formatPercent(podium.second.accuracyPct)} acur.
                                            </div>
                                            <div className="text-[9px] font-bold text-slate-400 truncate">
                                                Div: {formatSignedPercent(podium.second.divergencePct)}
                                            </div>
                                        </div>
                                    </div>
                                ) : <div className="rounded-xl border border-dashed border-slate-800" />}

                                {/* 1º LUGAR */}
                                <div
                                    onClick={() => onOpenAudit && onOpenAudit(podium.first.originalRow)}
                                    className="p-3 rounded-xl border-2 border-amber-500/50 bg-gradient-to-b from-amber-500/15 via-slate-900 to-slate-950 hover:border-amber-400 hover:scale-[1.02] transition-all cursor-pointer flex flex-col justify-between shadow-lg"
                                >
                                    <div>
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs font-black text-amber-300">1º LUGAR</span>
                                            <span className="text-sm">{podium.first.tierEmoji}</span>
                                        </div>
                                        <p className="font-black text-sm text-white truncate mt-1">
                                            {podium.first.branch}
                                        </p>
                                        <p className="text-[10px] text-amber-200/80 truncate">{podium.first.area}</p>
                                    </div>
                                    <div className="mt-2 pt-2 border-t border-amber-500/30">
                                        <div className="text-sm font-black text-emerald-400">
                                            {formatPercent(podium.first.accuracyPct)} acur.
                                        </div>
                                        <div className="text-[10px] font-bold text-slate-300 truncate">
                                            Div: {formatSignedPercent(podium.first.divergencePct)} ({formatSignedCurrency(podium.first.diffCost)})
                                        </div>
                                    </div>
                                </div>

                                {/* 3º LUGAR */}
                                {podium.third ? (
                                    <div
                                        onClick={() => onOpenAudit && onOpenAudit(podium.third!.originalRow)}
                                        className="p-2.5 rounded-xl border border-slate-800 bg-slate-900/60 hover:bg-slate-800/80 hover:border-slate-700 transition-all cursor-pointer flex flex-col justify-between"
                                    >
                                        <div>
                                            <div className="flex items-center justify-between text-slate-400">
                                                <span className="text-xs font-black">3º</span>
                                                <span className="text-xs">{podium.third.tierEmoji}</span>
                                            </div>
                                            <p className="font-black text-xs text-white truncate mt-1">
                                                {podium.third.branch}
                                            </p>
                                            <p className="text-[9px] text-slate-400 truncate">{podium.third.area}</p>
                                        </div>
                                        <div className="mt-2 pt-2 border-t border-slate-800/80">
                                            <div className="text-xs font-black text-emerald-400">
                                                {formatPercent(podium.third.accuracyPct)} acur.
                                            </div>
                                            <div className="text-[9px] font-bold text-slate-400 truncate">
                                                Div: {formatSignedPercent(podium.third.divergencePct)}
                                            </div>
                                        </div>
                                    </div>
                                ) : <div className="rounded-xl border border-dashed border-slate-800" />}

                            </div>
                        </div>
                    )}

                    {/* LISTA COMPLETA DO RANKING DINÂMICO */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <span className="text-[11px] font-black uppercase tracking-widest text-slate-400">
                                Classificação Completa ({rankedItems.length} lojas)
                            </span>
                            <span className="text-[10px] font-medium text-slate-500">
                                Clique para abrir a filial
                            </span>
                        </div>

                        {rankedItems.length === 0 ? (
                            <div className="p-8 text-center text-xs font-semibold text-slate-500 border border-dashed border-slate-800 rounded-xl">
                                Nenhuma auditoria encontrada para os filtros selecionados.
                            </div>
                        ) : (
                            rankedItems.map((item, index) => {
                                const rankPos = index + 1;
                                const isTop3 = rankPos <= 3 && item.hasRealCount;
                                const tierInfo = getPerformanceTier(item.absDivPct, item.hasRealCount);

                                return (
                                    <div
                                        key={item.key}
                                        onClick={() => onOpenAudit && onOpenAudit(item.originalRow)}
                                        className={`group relative p-3 rounded-xl border transition-all duration-150 cursor-pointer ${isTop3 ? 'border-amber-500/30 bg-slate-900/80 hover:bg-slate-900 hover:border-amber-400/50' : 'border-slate-800/80 bg-slate-950/60 hover:bg-slate-900/80 hover:border-slate-700'}`}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            
                                            {/* Posição e Identificação da Filial */}
                                            <div className="flex items-center gap-3 min-w-0">
                                                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-black text-xs ${item.hasRealCount && rankPos === 1 ? 'bg-amber-500 text-slate-950 font-black' : item.hasRealCount && rankPos === 2 ? 'bg-slate-300 text-slate-950 font-black' : item.hasRealCount && rankPos === 3 ? 'bg-amber-700 text-white font-black' : 'bg-slate-800 text-slate-300'}`}>
                                                    {rankPos}º
                                                </div>

                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <h4 className="font-black text-xs text-white truncate group-hover:text-amber-300 transition-colors">
                                                            {item.branch}
                                                        </h4>
                                                        {item.status === 'completed' ? (
                                                            <span className="rounded bg-emerald-500/10 px-1.5 py-0.2 text-[9px] font-bold text-emerald-400">
                                                                Fechada
                                                            </span>
                                                        ) : (
                                                            <span className="rounded bg-cyan-500/10 px-1.5 py-0.2 text-[9px] font-bold text-cyan-400">
                                                                Aberta
                                                            </span>
                                                        )}
                                                    </div>
                                                    <p className="text-[10px] text-slate-400 truncate">
                                                        {item.area} {item.city ? `• ${item.city}` : ''} {item.auditNumber > 0 ? `• Aud #${item.auditNumber}` : ''}
                                                    </p>
                                                </div>
                                            </div>

                                            {/* Acurácia (100%) vs Divergência (0%) */}
                                            <div className="flex flex-col items-end shrink-0">
                                                {item.hasRealCount ? (
                                                    <>
                                                        <div className="flex items-baseline gap-1">
                                                            <span className="text-sm font-black tabular-nums text-emerald-400">
                                                                {formatPercent(item.accuracyPct)}
                                                            </span>
                                                            <span className="text-[9px] font-bold text-slate-500">acur.</span>
                                                        </div>
                                                        <span className={`mt-0.5 px-1.5 py-0.2 rounded text-[8px] font-black uppercase border ${tierInfo.badgeBg}`}>
                                                            {tierInfo.emoji} Div: {formatSignedPercent(item.divergencePct)}
                                                        </span>
                                                    </>
                                                ) : (
                                                    <span className="px-2 py-1 rounded text-[9px] font-bold bg-slate-800 text-slate-400 border border-slate-700">
                                                        ⏳ Aguardando contagem
                                                    </span>
                                                )}
                                            </div>
                                        </div>

                                        {/* Detalhes Financeiros */}
                                        <div className="mt-2.5 flex items-center justify-between text-[10px] font-semibold text-slate-400 border-t border-slate-800/80 pt-2">
                                            <span>
                                                Auditado: <strong className="text-slate-200">{item.hasRealCount ? formatCurrency(item.countedCost) : 'R$ 0,00'}</strong>
                                            </span>
                                            {item.hasRealCount ? (
                                                <span className={item.diffCost < 0 ? 'text-rose-400' : item.diffCost > 0 ? 'text-emerald-400' : 'text-slate-400'}>
                                                    Divergência: <strong>{formatSignedCurrency(item.diffCost)}</strong>
                                                </span>
                                            ) : (
                                                <span className="text-slate-500">Sem itens bipados</span>
                                            )}
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>

                {/* MODAL DE ENVIO DO WHATSAPP */}
                {showWhatsappModal && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
                        <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-950 p-5 shadow-2xl flex flex-col max-h-[90vh]">
                            
                            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                                <div className="flex items-center gap-2 text-emerald-400">
                                    <MessageSquare className="h-5 w-5" />
                                    <h3 className="text-sm font-black text-white">
                                        MENSAGEM PARA WHATSAPP
                                    </h3>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setShowWhatsappModal(false)}
                                    className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 cursor-pointer"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            </div>

                            <p className="text-xs text-slate-400 mt-2">
                                Texto executivo pronto para envio nos grupos de gerentes e diretores:
                            </p>

                            {/* PREVIEW DO TEXTO */}
                            <div className="mt-3 flex-1 overflow-y-auto p-3 rounded-xl border border-slate-800 bg-slate-900 font-mono text-[11px] text-slate-300 whitespace-pre-wrap leading-relaxed custom-scrollbar">
                                {whatsappMessage}
                            </div>

                            {/* BOTÕES DE AÇÃO */}
                            <div className="mt-4 flex items-center gap-2 pt-2 border-t border-slate-800">
                                <button
                                    type="button"
                                    onClick={handleCopyWhatsapp}
                                    className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 py-2.5 px-3 text-xs font-black text-white transition-all cursor-pointer"
                                >
                                    {copiedWhatsapp ? (
                                        <>
                                            <Check className="h-4 w-4 text-emerald-400" />
                                            <span className="text-emerald-400">Copiado!</span>
                                        </>
                                    ) : (
                                        <>
                                            <Copy className="h-4 w-4" />
                                            <span>Copiar Mensagem</span>
                                        </>
                                    )}
                                </button>

                                <button
                                    type="button"
                                    onClick={handleOpenWhatsappWeb}
                                    className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 py-2.5 px-3 text-xs font-black text-white transition-all shadow-md cursor-pointer"
                                >
                                    <ExternalLink className="h-4 w-4" />
                                    <span>Abrir no WhatsApp</span>
                                </button>
                            </div>

                        </div>
                    </div>
                )}

            </div>
        </aside>
    );
};

export default AuditRankingPanel;
