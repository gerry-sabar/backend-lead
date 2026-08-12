import { DataTypes, Model, Sequelize } from 'sequelize';

// What we did with a delivery. Every inbound callback gets exactly one of these.
export const CallbackOutcome = {
  Applied: 'applied',
  DuplicateIgnored: 'duplicate_ignored',
  UnknownRef: 'unknown_ref',
  AmountMismatch: 'amount_mismatch',
  InvalidTransition: 'invalid_transition',
  Rejected: 'rejected',
} as const;

export type CallbackOutcome = (typeof CallbackOutcome)[keyof typeof CallbackOutcome];

export class PspCallback extends Model {
  declare id: string;
  declare pspRef: string | null;
  declare fundingTransactionId: string | null;
  declare payload: unknown;
  declare outcome: CallbackOutcome | null;
}

export function initPspCallback(sequelize: Sequelize): void {
  PspCallback.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      pspRef: { type: DataTypes.TEXT, allowNull: true },
      fundingTransactionId: { type: DataTypes.UUID, allowNull: true },
      payload: { type: DataTypes.JSONB, allowNull: false },
      outcome: { type: DataTypes.TEXT, allowNull: true },
    },
    { sequelize, tableName: 'psp_callbacks', underscored: true, updatedAt: false },
  );
}
