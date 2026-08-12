import { DataTypes, Model, Sequelize } from 'sequelize';

export const WalletTxType = {
  DepositCredit: 'deposit_credit',
  WagerDebit: 'wager_debit',
  WithdrawalDebit: 'withdrawal_debit',
} as const;

export type WalletTxType = (typeof WalletTxType)[keyof typeof WalletTxType];

export class WalletTx extends Model {
  declare id: string;
  declare walletId: string;
  declare fundingTransactionId: string | null;
  declare type: WalletTxType;
  // Signed: positive credits, negative debits. Balance == SUM(amount).
  declare amount: string;
  declare turnoverRequiredDelta: string;
  declare turnoverAccruedDelta: string;
  declare idempotencyKey: string;
  declare readonly createdAt: Date;
}

export function initWalletTx(sequelize: Sequelize): void {
  WalletTx.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      walletId: { type: DataTypes.UUID, allowNull: false },
      fundingTransactionId: { type: DataTypes.UUID, allowNull: true },
      type: { type: DataTypes.TEXT, allowNull: false },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      turnoverRequiredDelta: { type: DataTypes.DECIMAL(36, 18), allowNull: false, defaultValue: '0' },
      turnoverAccruedDelta: { type: DataTypes.DECIMAL(36, 18), allowNull: false, defaultValue: '0' },
      idempotencyKey: { type: DataTypes.TEXT, allowNull: false },
    },
    {
      sequelize,
      tableName: 'wallet_txs',
      underscored: true,
      // Append-only: rows are inserted once and never touched again. The database
      // rejects UPDATE/DELETE too (see the migration's trigger).
      updatedAt: false,
    },
  );
}
