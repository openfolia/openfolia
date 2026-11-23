import { ZardCommandDividerComponent } from '../command/command-divider.component';
import { ZardCommandInputComponent } from '../command/command-input.component';
import { ZardCommandListComponent } from '../command/command-list.component';
import { ZardCommandOptionGroupComponent } from '../command/command-option-group.component';
import { ZardCommandOptionComponent } from '../command/command-option.component';
import { ZardCommandComponent } from '../command/command.component';

export const ZardCommandImports = [
  ZardCommandComponent,
  ZardCommandInputComponent,
  ZardCommandListComponent,
  ZardCommandOptionComponent,
  ZardCommandOptionGroupComponent,
  ZardCommandDividerComponent,
] as const;
