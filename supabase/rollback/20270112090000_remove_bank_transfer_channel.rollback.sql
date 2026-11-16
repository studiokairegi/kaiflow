-- Rollback for 20270112090000: lets admins enable bank_transfer again.
-- It cannot restore the channel on providers that had it, because the migration removed it from their stored settings;
-- re-enable it per account in the Paystack provider settings if you really want it back.
create or replace function public.payments_set_paystack_options(p_channels text[], p_currencies text[])
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := payments_require_admin(); c text;
begin
  if p_channels is null or cardinality(p_channels) = 0 then raise exception 'Choose at least one payment channel.' using errcode = 'P0001'; end if;
  foreach c in array p_channels loop
    if c not in ('card', 'bank_transfer', 'apple_pay') then raise exception 'Unsupported channel %.', c using errcode = 'P0001'; end if;
  end loop;
  if p_currencies is null or cardinality(p_currencies) = 0 then raise exception 'Choose at least one currency.' using errcode = 'P0001'; end if;
  foreach c in array p_currencies loop
    if c not in ('KES', 'USD', 'NGN', 'GHS', 'ZAR') then raise exception 'Paystack cannot collect %.', c using errcode = 'P0001'; end if;
  end loop;
  update payment_providers
     set settings = settings || jsonb_build_object('channels', to_jsonb(p_channels), 'currencies', to_jsonb(p_currencies)),
         updated_at = now()
   where user_id = uid and provider = 'paystack';
  if not found then raise exception 'Connect Paystack first.' using errcode = 'P0001'; end if;
  perform finance_audit(uid, 'configure', 'payment_provider', null, null,
    jsonb_build_object('provider', 'paystack', 'channels', p_channels, 'currencies', p_currencies));
end
$$;
