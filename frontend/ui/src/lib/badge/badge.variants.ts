import { cva, type VariantProps } from 'class-variance-authority';

export const badgeVariants = cva(
  'group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:pointer-events-none [&>svg]:size-3!',
  {
    variants: {
      zType: {
        default: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        destructive:
          'bg-destructive-muted text-destructive border-destructive/30',
        outline: 'border-border text-foreground',
        success: 'bg-success-muted text-success border-success/30',
        warning: 'bg-warning-muted text-warning border-warning/30',
        info: 'bg-info-muted text-info border-info/30',
      },
    },
    defaultVariants: { zType: 'default' },
  },
);

export type ZardBadgeTypeVariants = NonNullable<
  VariantProps<typeof badgeVariants>['zType']
>;
