/**
 * Интерфейс хранилища для движка (вариант 4). Можно реализовать Redis/Postgres/что угодно.
 * Все методы — асинхронные.
 *
 * export type Storage = {
 *   ready(): Promise<boolean>,
 *   getAddresses(userId:number, limit?:number): Promise<any[]>,
 *   saveAddress(userId:number, addressFull:string, addressJSON:any): Promise<void>,
 *   savePhone(userId:number, phone:string, isPrimary?:boolean): Promise<void>,
 *   loadCart(userId:number): Promise<Array<{id:string,name:string,cost:number,count:number}>>,
 *   saveCart(userId:number, items:Array<{id:string,name:string,cost:number,count:number}>): Promise<void>,
 *   loadAllMenuOrders(): Promise<Array<{parentId:string|null, orderedIds:string[], hiddenIds:string[]}>>,
 *   saveMenuOrder(parentId:string|null, orderedIds:string[], hiddenIds:string[]): Promise<void>
 * }
 */
export {};
