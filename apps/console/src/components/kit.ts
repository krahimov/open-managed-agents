/**
 * The Muse kit — one import for the shared components.
 *
 *   import { DetailHeader, PropertyList, Property, EntityRef, StatusBadge } from "@/components/kit";
 *
 * What each one is for, with usage, is in apps/console/DESIGN.md. See them
 * rendered with live data at /_kit.
 */

// Identity
export { AgentAvatar, EntityAvatar, type AvatarSize } from "./AgentAvatar";
export { Avatar } from "./Avatar";
export { EntityRef } from "./EntityRef";
export { IdChip, CopyButton } from "./IdChip";
export { ModelBadge } from "./ModelBadge";
export { RelativeTime } from "./RelativeTime";

// Status and labels
export { StatusBadge, StatusDot, StatusPill, Chip, statusDef, type StatusTone } from "./Badge";
export { Kbd } from "./Kbd";
export { Tip } from "./Tip";
export { Callout } from "./Callout";

// Page structure
export { Page, PAGE_GUTTER, PAGE_WIDTH, type PageWidth } from "./Page";
export { PageHeader } from "./PageHeader";
export { DetailHeader } from "./DetailHeader";
export { TabBar, useTabParam, type TabItem } from "./TabBar";
export { Section, SectionCard, Card, sectionLinkClass } from "./SectionCard";
export { PropertyList, Property } from "./PropertyList";
export { SettingRow } from "./SettingRow";
export { Steps } from "./Steps";
export { Wash } from "./Wash";

// Lists
export { DataTable, RowLink, LoadMoreSentinel, type ColumnDef, type DataTableProps } from "./DataTable";
export { OverflowTip } from "./OverflowTip";
export { ListToolbar, SearchInput } from "./Toolbar";
export { FilterChip, CreatedFilterChip } from "./FilterChip";
export { FacetedFilter } from "./FacetedFilter";
export { RowActionsMenu, type RowAction } from "./RowActionsMenu";
export { SegmentedControl } from "./SegmentedControl";
export { AgentCard } from "./AgentCard";

// Numbers and charts
export { StatTile, type StatDelta } from "./StatTile";
export { Sparkline, TimeSeriesChart, BarList, Meter, ChartLegend, type ChartSeries } from "./charts";

// Conversation
export { Composer, type ComposerHandle } from "./Composer";
export { AgentPicker } from "./AgentPicker";
export { EventCard, EventSection, CodeWell } from "./EventCard";
export { Markdown } from "./Markdown";

// States
export { EmptyState, RecordNotFound } from "./EmptyState";
export { QueryProblem, ErrorState } from "./QueryProblem";
export { Skeleton, SkeletonText, SkeletonCard, SkeletonRows, SkeletonDetail } from "./Skeleton";
export { BrandLoader } from "./BrandLoader";

// Overlays and forms
export { Modal } from "./Modal";
export { ConfirmDialog } from "./ConfirmDialog";
export { Field } from "./Field";
export { TextInput, SecretInput } from "./Input";
export { Select, SelectOption, SelectGroup, SelectGroupLabel, SelectSeparator } from "./Select";
export { Combobox } from "./Combobox";
export { LocalCombobox } from "./LocalCombobox";
export { Disclosure } from "./Disclosure";
export { DateField } from "./DateField";
export { PanelGroup } from "./PanelGroup";

// Third-party apps and things to paste elsewhere
export { AppIcon } from "./agents/controls";
export { CopyList, CopyRow, CommandLine, SecretOnce } from "./settings/CopyField";
export { ChipRow } from "./resources/ResourceBits";
