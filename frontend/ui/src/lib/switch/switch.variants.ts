import { cva, type VariantProps } from 'class-variance-authority';

export const switchVariants = cva(
  'peer relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent px-px transition-all outline-none after:absolute after:-inset-x-3 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-[state=checked]:bg-primary data-[state=unchecked]:border-muted-foreground data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80 disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      zSize: {
        // Whole pixels (not rem, as the track): the knob (14 and 10 px) keeps 1 px of the
        // track on every side, and moves by its own width. The touch target is the `after`.
        default: 'h-[18px] w-[32px] after:-inset-y-[8.2px]',
        sm: 'h-[14px] w-[24px] after:-inset-y-2',
      },
    },
    defaultVariants: {
      zSize: 'default',
    },
  },
);

export type ZardSwitchSizeVariants = NonNullable<
  VariantProps<typeof switchVariants>['zSize']
>;
