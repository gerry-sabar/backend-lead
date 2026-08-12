import { sequelize } from '../sequelize';
import { Member, initMember } from './member';
import { Wallet, initWallet } from './wallet';
import { FundingTransaction, initFundingTransaction } from './fundingTransaction';
import { WalletTx, initWalletTx } from './walletTx';
import { PspCallback, initPspCallback } from './pspCallback';

initMember(sequelize);
initWallet(sequelize);
initFundingTransaction(sequelize);
initWalletTx(sequelize);
initPspCallback(sequelize);

Member.hasOne(Wallet, { foreignKey: 'memberId', as: 'wallet' });
Wallet.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });

Wallet.hasMany(FundingTransaction, { foreignKey: 'walletId', as: 'fundingTransactions' });
FundingTransaction.belongsTo(Wallet, { foreignKey: 'walletId', as: 'wallet' });

Wallet.hasMany(WalletTx, { foreignKey: 'walletId', as: 'walletTxs' });
WalletTx.belongsTo(Wallet, { foreignKey: 'walletId', as: 'wallet' });

FundingTransaction.hasMany(WalletTx, { foreignKey: 'fundingTransactionId', as: 'walletTxs' });
WalletTx.belongsTo(FundingTransaction, { foreignKey: 'fundingTransactionId', as: 'fundingTransaction' });

export { Member, Wallet, FundingTransaction, WalletTx, PspCallback };
