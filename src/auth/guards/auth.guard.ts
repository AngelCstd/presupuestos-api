import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { IAuthRepository } from '../interfaces/auth-repository.interface';

/**
 * TASK-auth.md, Entregables: "AuthGuard — extrae Authorization, delega a
 * IAuthRepository, adjunta { userId, email } al request. Responsabilidad
 * única: validar token. No crea perfiles." Cualquier fallo de
 * IAuthRepository.validateToken() (firma inválida, expirado, claims
 * faltantes) se traduce aquí a 401 con mensaje genérico — nunca se expone
 * el detalle interno (T-3).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject('IAuthRepository') private readonly authRepository: IAuthRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: { userId: string; email: string } }>();

    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('No autenticado');
    }
    const token = header.slice('Bearer '.length);

    try {
      request.user = await this.authRepository.validateToken(token);
    } catch {
      throw new UnauthorizedException('No autenticado');
    }

    return true;
  }
}
