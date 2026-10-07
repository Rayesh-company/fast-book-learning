import {createHash} from 'node:crypto';
export const sha256Hex = value=>createHash('sha256').update(value,'utf8').digest('hex');
export const sha256HexBytes = value=>createHash('sha256').update(value).digest('hex');
