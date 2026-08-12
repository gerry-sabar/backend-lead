import { DataTypes, Model, Sequelize } from 'sequelize';
import { FundingTransactionStatus, FundingTransactionType } from '../../domain/fundingTransactionState';

export class FundingTransaction extends Model {
  declare id: string;
  declare memberId: string;
  declare walletId: string;
  declare type: FundingTransactionType;
  declare status: FundingTransactionStatus;
  // DECIMAL comes back from the pg driver as a string. Keep it that way; see src/lib/money.ts.
  declare amount: string;
  declare settledAmount: string | null;
  declare turnoverMultiplier: number | null;
  declare pspRef: string | null;
  declare statusReason: string | null;
}

export function initFundingTransaction(sequelize: Sequelize): void {
  FundingTransaction.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      memberId: { type: DataTypes.UUID, allowNull: false },
      walletId: { type: DataTypes.UUID, allowNull: false },
      type: { type: DataTypes.TEXT, allowNull: false },
      status: { type: DataTypes.TEXT, allowNull: false, defaultValue: FundingTransactionStatus.Pending },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      settledAmount: { type: DataTypes.DECIMAL(36, 18), allowNull: true },
      turnoverMultiplier: { type: DataTypes.INTEGER, allowNull: true },
      pspRef: { type: DataTypes.TEXT, allowNull: true },
      statusReason: { type: DataTypes.TEXT, allowNull: true },
    },
    { sequelize, tableName: 'funding_transactions', underscored: true },
  );
}
