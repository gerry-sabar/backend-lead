import { DataTypes, Model, Sequelize } from 'sequelize';

export class Wallet extends Model {
  declare id: string;
  declare memberId: string;
  // DECIMAL comes back from the pg driver as a string. Keep it that way; see src/lib/money.ts.
  declare balance: string;
  // Running totals for the withdrawal turnover lock. Both are caches of the ledger:
  // SUM(turnover_required_delta) and SUM(turnover_accrued_delta) over wallet_txs.
  declare turnoverRequired: string;
  declare turnoverAccrued: string;
}

export function initWallet(sequelize: Sequelize): void {
  Wallet.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      memberId: { type: DataTypes.UUID, allowNull: false },
      balance: { type: DataTypes.DECIMAL(36, 18), allowNull: false, defaultValue: '0' },
      turnoverRequired: { type: DataTypes.DECIMAL(36, 18), allowNull: false, defaultValue: '0' },
      turnoverAccrued: { type: DataTypes.DECIMAL(36, 18), allowNull: false, defaultValue: '0' },
    },
    { sequelize, tableName: 'wallets', underscored: true },
  );
}
